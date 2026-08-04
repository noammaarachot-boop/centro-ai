import { createHmac, timingSafeEqual } from "node:crypto";

export const WHATSAPP_OAUTH_STATE_COOKIE = "whatsapp_oauth_state";
export const WHATSAPP_OAUTH_RETURN_TO_COOKIE = "whatsapp_oauth_return_to";
export const WHATSAPP_OAUTH_REDIRECT_URI_COOKIE = "whatsapp_oauth_redirect_uri";

export interface WhatsAppOAuthStatePayload {
  csrf: string;
  returnTo: string;
  redirectUri: string;
  exp: number;
  // When true, oauth callback returns HTML that closes the popup window.
  popup?: boolean;
}

function b64urlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function b64urlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signingSecret(): string {
  // Prefer app secret when present; fall back so local diagnosis still works.
  return (
    process.env.WHATSAPP_APP_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    "centro-whatsapp-oauth-dev-only"
  );
}

function sign(body: string): string {
  return createHmac("sha256", signingSecret()).update(body).digest("base64url");
}

export function encodeWhatsAppOAuthState(payload: WhatsAppOAuthStatePayload): string {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function decodeWhatsAppOAuthState(state: string): WhatsAppOAuthStatePayload | null {
  const [body, sig] = state.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(b64urlDecode(body)) as WhatsAppOAuthStatePayload;
    if (
      !parsed ||
      typeof parsed.csrf !== "string" ||
      typeof parsed.returnTo !== "string" ||
      typeof parsed.redirectUri !== "string" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }
    if (parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function buildPopupResultHtml(result: {
  ok: boolean;
  error?: string;
  returnTo: string;
}): string {
  const payload = JSON.stringify({
    type: "centro-whatsapp-oauth",
    ok: result.ok,
    error: result.error ?? null,
    returnTo: result.returnTo,
  });
  // Closes popup and notifies opener so the main wizard can refresh.
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>WhatsApp</title></head>
<body>
<script>
(function () {
  var msg = ${payload};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(msg, window.location.origin);
    }
  } catch (e) {}
  try { window.close(); } catch (e) {}
  // If the browser blocks window.close(), show a short status.
  document.body.innerHTML = msg.ok
    ? '<p style="font-family:system-ui;padding:24px">WhatsApp connected. You can close this window.</p>'
    : '<p style="font-family:system-ui;padding:24px">Connection failed. You can close this window.</p>';
})();
</script>
</body></html>`;
}

// Strip OAuth result flags so retries/doubles don't pile error= / whatsapp=.
export function cleanWhatsAppReturnTo(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://")) {
    return "/settings";
  }
  try {
    const url = new URL(path, "https://www.centro-ai.co.il");
    for (const key of ["error", "whatsapp"]) {
      url.searchParams.delete(key);
    }
    // Facebook often appends #_=_
    const search = url.searchParams.toString();
    return search ? `${url.pathname}?${search}` : url.pathname;
  } catch {
    return "/settings";
  }
}

export function buildReturnRedirect(
  returnTo: string,
  params: Record<string, string>
): string {
  const cleaned = cleanWhatsAppReturnTo(returnTo);
  const url = new URL(cleaned, "https://www.centro-ai.co.il");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}
