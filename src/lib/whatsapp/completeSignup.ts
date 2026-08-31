import { recordAuditEvent } from "@/lib/audit";
import {
  exchangeSignupCode,
  resolveWabaIdFromToken,
  subscribeToWabaWebhooks,
  verifyCentroAppSubscribed,
  WhatsAppSignupError,
  type WhatsAppSignupStep,
} from "@/lib/whatsapp/embeddedSignup";
import {
  listPhoneNumbersOnWaba,
  getFirstPhoneNumberForWaba,
  WhatsAppApiError,
} from "@/lib/whatsapp/phoneNumbers";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";

async function getExistingConnection(
  organizationId: string
): Promise<{ wabaId: string | null; phoneNumberId: string | null }> {
  const db = await getDb();
  const [org] = await db
    .select({
      wabaId: organizations.whatsappBusinessAccountId,
      phoneNumberId: organizations.whatsappPhoneNumberId,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return { wabaId: org?.wabaId ?? null, phoneNumberId: org?.phoneNumberId ?? null };
}
import { recordWebhookSubscriptionState, storeWabaConnection } from "@/lib/whatsapp/wabaTokens";
import { ensureTemplatesProvisioned } from "@/lib/whatsapp/templates";

export interface CompleteWhatsAppSignupResult {
  ok: true;
  webhooksSubscribed: boolean;
  wabaId: string;
  displayPhoneNumber: string;
}

// Shared Embedded Signup completion for both the legacy FB.login POST
// callback and the full-page dialog/oauth GET callback. Order:
//   1. exchange code → user access token
//   2. resolve WABA from that token
//   3. list phone numbers (user token first)
//   4. store connection
//   5. webhook subscribe (best-effort)
//   6. template provisioning (best-effort)
export async function completeWhatsAppSignup(params: {
  organizationId: string;
  userId: string;
  code: string;
  preferredRedirectUris?: Array<string | null | undefined>;
  // When true, only try preferred URIs (exact dialog redirect) — used by
  // the controlled dialog/oauth redirect flow so Meta 36008 cannot arise
  // from fallback candidates that never bound the code.
  onlyPreferred?: boolean;
}): Promise<CompleteWhatsAppSignupResult> {
  let step: WhatsAppSignupStep = "code-exchange";
  try {
    step = "code-exchange";
    const userAccessToken = await exchangeSignupCode(
      params.code,
      params.preferredRedirectUris,
      { onlyPreferred: params.onlyPreferred === true }
    );

    step = "waba-resolve";
    const wabaId = await resolveWabaIdFromToken(userAccessToken);

    step = "phone-lookup";
    // Repairing an existing connection must keep the SAME number.
    //
    // A WABA can hold several numbers, and "the first one Meta returns"
    // is not a choice — re-pointing an office at a different number would
    // message its clients from a number they have never seen and orphan
    // the conversation history keyed to the old phone_number_id. When the
    // organization already has one, that exact id must still be on the
    // WABA or the flow stops rather than attaching the wrong number.
    const existing = await getExistingConnection(params.organizationId);

    // The WABA is checked BEFORE the phone number, because it produces the
    // answer the operator can act on. Checking only the number reported
    // "your number is not in the selected account" — true, but it never said
    // that a DIFFERENT account had been selected, which is the actual
    // mistake and the only thing worth telling someone.
    if (existing.wabaId && existing.wabaId !== wabaId) {
      throw new WhatsAppSignupError(
        `בתהליך נבחר חשבון WhatsApp אחר (${wabaId}) מזה שהארגון כבר מחובר אליו ` +
          `(${existing.wabaId}). החיבור הקיים נשמר ולא שונה. יש להריץ שוב ולבחור בדיאלוג ` +
          `של Meta את אותו חשבון ואותו מספר הקיימים.`,
        "waba-resolve",
        { message: "wrong-waba", selectedWabaId: wabaId, expectedWabaId: existing.wabaId }
      );
    }

    let phoneNumber;
    if (existing.phoneNumberId) {
      const lookup = await listPhoneNumbersOnWaba(wabaId, userAccessToken);
      const matched = lookup.find((row) => row.id === existing.phoneNumberId);
      if (!matched) {
        // Names what was actually found, so the next attempt is informed
        // rather than another guess.
        throw new WhatsAppSignupError(
          `המספר שהארגון מחובר אליו (${existing.phoneNumberId}) אינו נמצא בחשבון שנבחר. ` +
            `המספרים שנמצאו בחשבון: ${lookup.map((r) => `${r.displayPhoneNumber || r.id}`).join(", ") || "אין"}. ` +
            `החיבור הקיים נשמר ולא שונה.`,
          "phone-lookup",
          { message: "wrong-phone-number", expectedPhoneNumberId: existing.phoneNumberId }
        );
      }
      phoneNumber = matched;
    } else {
      phoneNumber = await getFirstPhoneNumberForWaba(wabaId, userAccessToken);
    }

    step = "store";
    await storeWabaConnection(params.organizationId, {
      businessAccountId: wabaId,
      phoneNumberId: phoneNumber.id,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
      verifiedName: phoneNumber.verifiedName,
    });

    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "integration.whatsapp_connected",
      description: `חשבון WhatsApp Business חובר (${phoneNumber.displayPhoneNumber})`,
      actorType: "employee",
      actorUserId: params.userId,
    });

    // Subscribe Centro's Meta App to THIS organization's WABA, then read
    // back that it actually took.
    //
    // The WABA stays the organization's own — this only authorises Centro's
    // app to receive its webhooks. Verification is separate from the POST
    // on purpose: POST /{waba}/subscribed_apps subscribes the app that
    // ISSUED the token, so a token from another app returns success while
    // Centro's app is never attached. That ran undetected in production —
    // outbound worked for days (sending needs no subscription) while every
    // inbound message was delivered to the other app.
    step = "webhook-subscribe";
    const subscribePosted = await subscribeToWabaWebhooks(wabaId, userAccessToken);
    const verification = await verifyCentroAppSubscribed(wabaId, userAccessToken);
    const webhooksOk = subscribePosted && verification.subscribed;
    if (!webhooksOk) {
      console.error("[whatsapp-oauth] Centro's app is NOT subscribed to this WABA — inbound will not arrive", {
        organizationId: params.organizationId,
        wabaId,
        subscribePosted,
        verified: verification.subscribed,
        subscribedAppIds: verification.subscribedAppIds,
        error: verification.error,
      });
    }
    await recordWebhookSubscriptionState(params.organizationId, webhooksOk);

    try {
      // The organization's own token: the shared one has no access to this
      // WABA, so provisioning with it silently did nothing.
      await ensureTemplatesProvisioned(wabaId, undefined, userAccessToken);
    } catch (error) {
      console.error("[whatsapp-oauth] template auto-provisioning failed (non-fatal)", error);
    }

    return {
      ok: true,
      webhooksSubscribed: webhooksOk,
      wabaId,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
    };
  } catch (error) {
    if (error instanceof WhatsAppSignupError || error instanceof WhatsAppApiError) {
      throw error;
    }
    throw new WhatsAppSignupError(
      error instanceof Error ? error.message : String(error),
      step
    );
  }
}
