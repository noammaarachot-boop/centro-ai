import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppSignupError extends Error {}

// Embedded Signup's client-side FB.login() popup returns a short-lived
// `code` — exchanging it is what actually confirms, on Meta's side, that
// the signup completed, and (see resolveWabaIdFromToken below) is also
// how the connected WABA is identified. The returned token itself is
// used only transiently for that lookup and then discarded: Centro
// sends/receives through the one shared WHATSAPP_SYSTEM_USER_TOKEN (Tech
// Provider model), never a per-org token.
export async function exchangeSignupCode(code: string): Promise<string> {
  const { appId, appSecret, oauthRedirectUri } = getWhatsAppConfig();
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  // Only sent when configured — see WhatsAppConfig.oauthRedirectUri for
  // why this is conditional rather than always included.
  if (oauthRedirectUri) params.set("redirect_uri", oauthRedirectUri);

  const response = await withRetry(() => fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`));
  if (!response.ok) {
    const body = await response.text();
    throw new WhatsAppSignupError(`Signup code exchange failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new WhatsAppSignupError("Signup code exchange returned no access token");
  }
  return data.access_token;
}

// Server-side substitute for Meta's WA_EMBEDDED_SIGNUP postMessage —
// confirmed via live testing (including a correctly-configured `extras`
// param on FB.login()) to never fire for this app/configuration, so the
// connected WhatsApp Business Account is identified a different way:
// Meta's token-introspection endpoint reports exactly which assets this
// specific signup granted access to, via granular_scopes.
export async function resolveWabaIdFromToken(userAccessToken: string): Promise<string> {
  const { appId, appSecret } = getWhatsAppConfig();
  const params = new URLSearchParams({
    input_token: userAccessToken,
    access_token: `${appId}|${appSecret}`,
  });
  const response = await withRetry(() => fetch(`${GRAPH_API_BASE}/debug_token?${params.toString()}`));
  if (!response.ok) {
    const body = await response.text();
    throw new WhatsAppSignupError(`Token introspection failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as {
    data?: { granular_scopes?: Array<{ scope: string; target_ids?: string[] }> };
  };
  // Prefer whatsapp_business_management (matches the four templates'
  // Configuration setup and every live test so far), but fall back to
  // whatsapp_business_messaging — depending on exactly which permissions
  // the eventual working Configuration's own "Permissions" step ends up
  // requesting, only one of the two might actually be granted. Both have
  // shown identical target_ids in every real token inspected during this
  // integration's live testing, so either is a reliable source of the
  // WABA id.
  const scopes = data.data?.granular_scopes ?? [];
  const wabaId =
    scopes.find((scope) => scope.scope === "whatsapp_business_management")?.target_ids?.[0] ??
    scopes.find((scope) => scope.scope === "whatsapp_business_messaging")?.target_ids?.[0];
  if (!wabaId) {
    throw new WhatsAppSignupError(
      "Exchanged token was not granted access to any WhatsApp Business Account (missing whatsapp_business_management/whatsapp_business_messaging granular scope)"
    );
  }
  return wabaId;
}

// Centro's fixed production domain — this deployment has exactly one,
// so it's a stable constant rather than an env var. Must exactly match
// the Callback URL already verified in the Meta App Dashboard's
// WhatsApp Configuration; Meta rejects a mismatched callback_url on the
// app-level subscription call below.
const WEBHOOK_CALLBACK_URL = "https://www.centro-ai.co.il/api/webhooks/whatsapp";

// Required for Centro's app to actually receive this WABA's webhook
// events (messages, statuses) — Embedded Signup connects the number but
// does not implicitly subscribe the app to it. Two genuinely separate
// Meta subscriptions are both needed, confirmed the hard way during live
// M-WA-4 testing (the WABA-level call alone produced zero inbound
// webhook deliveries — Meta simply never called the endpoint until the
// app-level one below was also done, at the time by hand, outside any
// code path):
//   1. WABA -> app link (per connection, below) — "this WABA should
//      send its events to this app."
//   2. App -> field subscription (also below, idempotent, safe to repeat
//      on every connection) — "this app actually wants the `messages`
//      field." Without this, step 1 alone delivers nothing.
// Step 1 uses the shared System User token like every other per-WABA
// Cloud API call. Step 2 is an admin operation on the app itself, not on
// any WABA, so it authenticates as an app access token (appId|appSecret,
// the same shape exchangeSignupCode/resolveWabaIdFromToken already use)
// instead — this is what actually worked when this call was first
// confirmed live, by hand.
export async function subscribeToWabaWebhooks(wabaId: string): Promise<void> {
  const { appId, appSecret, systemUserToken, webhookVerifyToken } = getWhatsAppConfig();

  const wabaResponse = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${systemUserToken}` },
    })
  );
  if (!wabaResponse.ok) {
    const body = await wabaResponse.text();
    throw new WhatsAppSignupError(`Webhook subscription failed (${wabaResponse.status}): ${body}`);
  }

  if (!webhookVerifyToken) {
    console.error(
      "[whatsapp] WHATSAPP_WEBHOOK_VERIFY_TOKEN not configured — skipping app-level webhook field subscription; inbound messages will not be delivered until this is set and a connection is retried"
    );
    return;
  }

  const fieldParams = new URLSearchParams({
    object: "whatsapp_business_account",
    callback_url: WEBHOOK_CALLBACK_URL,
    verify_token: webhookVerifyToken,
    fields: "messages",
    access_token: `${appId}|${appSecret}`,
  });
  const fieldResponse = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${appId}/subscriptions`, { method: "POST", body: fieldParams })
  );
  if (!fieldResponse.ok) {
    // Non-fatal — the WABA-level link above already succeeded, and this
    // is idempotent/repeatable on the next connection or a manual retry,
    // so a transient failure here shouldn't undo an otherwise-successful
    // signup.
    const body = await fieldResponse.text();
    console.error(`[whatsapp] app-level webhook field subscription failed (${fieldResponse.status}): ${body}`);
  }
}
