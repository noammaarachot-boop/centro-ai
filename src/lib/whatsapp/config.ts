import {
  WHATSAPP_HARDCODE_ENABLED,
  WHATSAPP_HARDCODED,
} from "./hardcodedConfig";

// Graph API base shared by every whatsapp/* module — same role as
// googleAuth/config.ts's GOOGLE_DRIVE_SCOPE constant.
export const GRAPH_API_VERSION = "v21.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsAppConfig {
  appId: string;
  appSecret: string;
  systemUserToken: string;
  // Echoed on code exchange when set. During hardcoded diagnosis this is
  // the site origin, not necessarily the full-page oauth path.
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
  const appId = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.appId
    : process.env.NEXT_PUBLIC_WHATSAPP_APP_ID;

  const appSecret =
    WHATSAPP_HARDCODE_ENABLED && WHATSAPP_HARDCODED.appSecret
      ? WHATSAPP_HARDCODED.appSecret
      : process.env.WHATSAPP_APP_SECRET;

  const systemUserToken =
    WHATSAPP_HARDCODE_ENABLED && WHATSAPP_HARDCODED.systemUserToken
      ? WHATSAPP_HARDCODED.systemUserToken
      : process.env.WHATSAPP_SYSTEM_USER_TOKEN;

  const oauthRedirectUri = WHATSAPP_HARDCODE_ENABLED
    ? WHATSAPP_HARDCODED.oauthRedirectUri
    : process.env.WHATSAPP_OAUTH_REDIRECT_URI?.trim() || null;

  const webhookVerifyToken =
    WHATSAPP_HARDCODE_ENABLED && WHATSAPP_HARDCODED.webhookVerifyToken
      ? WHATSAPP_HARDCODED.webhookVerifyToken
      : process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || null;

  if (!appId || !appSecret || !systemUserToken) {
    throw new Error(
      "WhatsApp is not configured. Set NEXT_PUBLIC_WHATSAPP_APP_ID, WHATSAPP_APP_SECRET, and WHATSAPP_SYSTEM_USER_TOKEN." +
        (WHATSAPP_HARDCODE_ENABLED
          ? " (hardcode mode: appId/config are fixed; secrets still need Vercel or hardcodedConfig.ts appSecret/systemUserToken)"
          : "")
    );
  }

  if (WHATSAPP_HARDCODE_ENABLED) {
    console.log("[whatsapp-config] HARDCODE mode", {
      appId,
      oauthRedirectUri,
      secretFrom: WHATSAPP_HARDCODED.appSecret ? "hardcodedConfig" : "env",
      tokenFrom: WHATSAPP_HARDCODED.systemUserToken ? "hardcodedConfig" : "env",
    });
  }

  return {
    appId,
    appSecret,
    systemUserToken,
    oauthRedirectUri,
    webhookVerifyToken,
  };
}
