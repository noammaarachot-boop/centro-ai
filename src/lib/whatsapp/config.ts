// Graph API base shared by every whatsapp/* module — same role as
// googleAuth/config.ts's GOOGLE_DRIVE_SCOPE constant.
export const GRAPH_API_VERSION = "v21.0";
export const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface WhatsAppConfig {
  appId: string;
  appSecret: string;
  systemUserToken: string;
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

  return { appId, appSecret, systemUserToken };
}
