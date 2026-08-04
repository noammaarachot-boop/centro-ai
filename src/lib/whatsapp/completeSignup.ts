import { recordAuditEvent } from "@/lib/audit";
import {
  exchangeSignupCode,
  resolveWabaIdFromToken,
  subscribeToWabaWebhooks,
  WhatsAppSignupError,
  type WhatsAppSignupStep,
} from "@/lib/whatsapp/embeddedSignup";
import { getFirstPhoneNumberForWaba, WhatsAppApiError } from "@/lib/whatsapp/phoneNumbers";
import { storeWabaConnection } from "@/lib/whatsapp/wabaTokens";
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

    step = "webhook-subscribe";
    const webhooksOk = await subscribeToWabaWebhooks(wabaId, userAccessToken);
    if (!webhooksOk) {
      console.error(
        `[whatsapp-oauth] connection stored for org=${params.organizationId} waba=${wabaId}, but WABA webhook subscription failed (non-fatal; inbound messages may not arrive until reconnect)`
      );
    }

    try {
      await ensureTemplatesProvisioned(wabaId);
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
