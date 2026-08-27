import { recordAuditEvent } from "@/lib/audit";
import {
  exchangeSignupCode,
  resolveWabaIdFromToken,
  subscribeToWabaWebhooks,
  verifyCentroAppSubscribed,
  WhatsAppSignupError,
  type WhatsAppSignupStep,
} from "@/lib/whatsapp/embeddedSignup";
import { getFirstPhoneNumberForWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
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
    const phoneNumber = await getFirstPhoneNumberForWaba(wabaId, userAccessToken);

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
