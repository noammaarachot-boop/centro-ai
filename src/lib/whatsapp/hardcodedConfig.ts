/**
 * TEMPORARY diagnosis switch — force known production Meta values in code
 * so a wrong/missing Vercel env cannot hide the real App ID / Config ID /
 * redirect mismatch.
 *
 * Set ENABLED=false (or remove this module's use) once connect works and
 * secrets should live only in Vercel env again.
 *
 * NEVER commit real App Secret / System User tokens into this file.
 * Leave those strings empty so Vercel env still supplies secrets only.
 */

export const WHATSAPP_HARDCODE_ENABLED = true;

// Known live Centro Meta app (confirmed via browser debug + dialog URL).
export const WHATSAPP_HARDCODED = {
  appId: "1043370264820423",
  configId: "2531621403952088",
  // Prefer site origin for FB.login code exchange (Valid OAuth list).
  oauthRedirectUri: "https://www.centro-ai.co.il/",
  siteOrigin: "https://www.centro-ai.co.il",
  siteOriginTrailing: "https://www.centro-ai.co.il/",
  oauthCallbackUri: "https://www.centro-ai.co.il/api/auth/whatsapp/oauth",
  // Optional: paste only for local diagnosis, then clear before commit/push.
  appSecret: "",
  systemUserToken: "",
  webhookVerifyToken: "",
} as const;

export function getHardcodedPublicAppId(): string {
  return WHATSAPP_HARDCODED.appId;
}

export function getHardcodedConfigId(): string {
  return WHATSAPP_HARDCODED.configId;
}
