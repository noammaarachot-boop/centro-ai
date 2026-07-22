import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppSignupError extends Error {}

// Embedded Signup's client-side FB.login() popup returns a short-lived
// `code`, not a token — exchanging it is what actually confirms, on
// Meta's side, that the signup completed. The resulting business token is
// deliberately discarded: Centro sends/receives through the one shared
// WHATSAPP_SYSTEM_USER_TOKEN (Tech Provider model), never a per-org token.
export async function exchangeSignupCode(code: string): Promise<void> {
  const { appId, appSecret } = getWhatsAppConfig();
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });

  const response = await withRetry(() => fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`));
  if (!response.ok) {
    const body = await response.text();
    throw new WhatsAppSignupError(`Signup code exchange failed (${response.status}): ${body}`);
  }
}

// Required for Centro's app to actually receive this WABA's webhook
// events (messages, statuses) — Embedded Signup connects the number but
// does not implicitly subscribe the app to it. An app-level operation
// (not per-org), so it uses the shared System User token like every other
// Cloud API call.
export async function subscribeToWabaWebhooks(wabaId: string): Promise<void> {
  const { systemUserToken } = getWhatsAppConfig();
  const response = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
      method: "POST",
      headers: { Authorization: `Bearer ${systemUserToken}` },
    })
  );
  if (!response.ok) {
    const body = await response.text();
    throw new WhatsAppSignupError(`Webhook subscription failed (${response.status}): ${body}`);
  }
}
