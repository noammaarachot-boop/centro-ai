import { randomBytes } from "node:crypto";

// Centro's fixed production origin — this deployment has exactly one, so
// it's a stable constant rather than an env var (same reasoning the
// app-level WEBHOOK_CALLBACK_URL below was already written with; that
// constant now lives here so the domain has a single source of truth
// instead of being repeated per call site).
const PRODUCTION_ORIGIN = "https://www.centro-ai.co.il";

// The app-level default. Must exactly match the Callback URL verified in
// the Meta App Dashboard's WhatsApp Configuration — Meta rejects a
// mismatched callback_url on the app-level subscription call
// (embeddedSignup.ts's subscribeToWabaWebhooks). Every organization
// without a per-number override receives its events here.
export const WEBHOOK_CALLBACK_URL = `${PRODUCTION_ORIGIN}/api/webhooks/whatsapp`;

// Meta caps an override callback URL at 200 characters. Ours is ~64 with a
// real 15-16 digit phone number id, so this is a guard against a future
// origin/path change silently exceeding it, not a live constraint.
const META_OVERRIDE_URL_MAX_LENGTH = 200;

// The per-phone-number override URL (Meta "Webhook overrides"). Meta
// resolves a message's destination in this order: the phone number's own
// override → its WABA's override → the app's default callback URL. Giving
// a manually-connected number its own URL means that office's inbound
// traffic is separable in logs/monitoring from every other tenant's,
// without changing how the payload itself is routed to an organization
// (that has always been by phone_number_id inside the payload, and still
// is — see the dynamic route, which delegates to the shared POST handler).
export function buildPhoneNumberWebhookUrl(phoneNumberId: string): string {
  const url = `${WEBHOOK_CALLBACK_URL}/${encodeURIComponent(phoneNumberId)}`;
  if (url.length > META_OVERRIDE_URL_MAX_LENGTH) {
    throw new Error(
      `Webhook override URL exceeds Meta's ${META_OVERRIDE_URL_MAX_LENGTH}-character limit: ${url.length} characters.`
    );
  }
  return url;
}

// A fresh per-connection handshake secret. Only ever proves the one-time
// hub.challenge exchange — it grants no API access, and message
// authenticity is enforced separately by the X-Hub-Signature-256 HMAC
// against WHATSAPP_APP_SECRET. URL-safe so it survives being copied out of
// the owner screen and pasted into Meta by hand.
export function generateWebhookVerifyToken(): string {
  return randomBytes(24).toString("base64url");
}
