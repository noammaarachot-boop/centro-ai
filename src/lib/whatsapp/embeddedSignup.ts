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
  const managementScope = data.data?.granular_scopes?.find(
    (scope) => scope.scope === "whatsapp_business_management"
  );
  const wabaId = managementScope?.target_ids?.[0];
  if (!wabaId) {
    throw new WhatsAppSignupError(
      "Exchanged token was not granted access to any WhatsApp Business Account (missing whatsapp_business_management granular scope)"
    );
  }
  return wabaId;
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
