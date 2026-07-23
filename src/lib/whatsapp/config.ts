// Graph API base shared by every whatsapp/* module — same role as
// googleAuth/config.ts's GOOGLE_DRIVE_SCOPE constant.
export const GRAPH_API_VERSION = "v21.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsAppConfig {
  appId: string;
  appSecret: string;
  systemUserToken: string;
  // Optional — only needed when the app's "Valid OAuth Redirect URIs" has
  // an entry configured, which makes Meta implicitly attach it to the
  // Embedded Signup authorization and then require it echoed back
  // byte-for-byte on the server-side code exchange, or the exchange fails
  // with error_subcode 36008. Meta's own base Embedded Signup sample
  // omits redirect_uri entirely, which is why this isn't required —
  // exchangeSignupCode only sends it when set, so setups with no
  // redirect URI configured keep working exactly as documented.
  oauthRedirectUri: string | null;
  // Same value the webhook route's GET handshake checks
  // (WHATSAPP_WEBHOOK_VERIFY_TOKEN) — also needed by
  // embeddedSignup.ts's subscribeToWabaWebhooks to ensure the app-level
  // "messages" field subscription, not just the per-WABA link. Optional
  // here so a misconfigured deployment degrades to "webhook subscription
  // skipped, connection still succeeds" rather than failing the whole
  // Embedded Signup flow over a missing webhook setting.
  webhookVerifyToken: string | null;
}

// Server-side config for the shared Tech Provider setup (see the WhatsApp
// plan: one WHATSAPP_SYSTEM_USER_TOKEN sends/receives for every connected
// organization — no per-org OAuth token, unlike Google Drive). Mirrors
// googleAuth/config.ts's throw-if-missing pattern.
export function getWhatsAppConfig(): WhatsAppConfig {
  const appId = process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  const systemUserToken = process.env.WHATSAPP_SYSTEM_USER_TOKEN;

  if (!appId || !appSecret || !systemUserToken) {
    throw new Error(
      "WhatsApp is not configured. Set NEXT_PUBLIC_WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, and WHATSAPP_SYSTEM_USER_TOKEN."
    );
  }

  return {
    appId,
    appSecret,
    systemUserToken,
    oauthRedirectUri: process.env.WHATSAPP_OAUTH_REDIRECT_URI || null,
    webhookVerifyToken: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || null,
  };
}
