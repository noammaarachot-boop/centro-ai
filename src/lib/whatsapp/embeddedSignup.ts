import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

// Safe step ids returned to the client on failure (WA-03). Do not put
// secrets or full Graph bodies here — those stay in server logs only.
export type WhatsAppSignupStep =
  | "code-exchange"
  | "waba-resolve"
  | "webhook-subscribe"
  | "phone-lookup"
  | "store"
  | "unknown";

export interface WhatsAppSignupPublicMeta {
  message?: string;
  code?: number;
  error_subcode?: number;
  // Which redirect_uri value was tried last (never includes secrets).
  tried_redirect_uri?: string | null;
  attempts?: Array<{
    redirectUri: string;
    status: number;
    code?: number;
    error_subcode?: number;
  }>;
}

export class WhatsAppSignupError extends Error {
  readonly step: WhatsAppSignupStep;
  readonly publicMeta?: WhatsAppSignupPublicMeta;

  constructor(
    message: string,
    step: WhatsAppSignupStep = "unknown",
    publicMeta?: WhatsAppSignupPublicMeta
  ) {
    super(message);
    this.name = "WhatsAppSignupError";
    this.step = step;
    this.publicMeta = publicMeta;
  }
}

// FB.login() may bind Meta's internal popup URI; the controlled
// dialog/oauth redirect flow binds our own `/api/auth/whatsapp/oauth`.
const FB_JS_SDK_REDIRECT_URI =
  "https://www.facebook.com/connect/login_success.html";

// Fixed production callback for the full-page OAuth dialog — must be
// listed byte-for-byte in Meta Valid OAuth Redirect URIs.
export const WHATSAPP_OAUTH_CALLBACK_PATH = "/api/auth/whatsapp/oauth";
export const WHATSAPP_OAUTH_CALLBACK_URI =
  "https://www.centro-ai.co.il/api/auth/whatsapp/oauth";

// Fallback site roots only for older FB.login trials.
const PREFERRED_SITE_REDIRECTS = [
  "https://www.centro-ai.co.il/",
  "https://www.centro-ai.co.il",
] as const;

// Embedded Signup returns a short-lived authorization `code`. Exchanging it
// confirms signup on Meta's side and yields a user token for WABA/phone
// discovery (see resolveWabaIdFromToken). The token is discarded after this
// request; runtime Cloud API calls use WHATSAPP_SYSTEM_USER_TOKEN.
//
// Meta 36008: exchange redirect_uri must match the OAuth dialog exactly.
// Prefer onlyPreferred when the dialog used a known server redirect_uri.
export async function exchangeSignupCode(
  code: string,
  preferredRedirectUris?: Array<string | null | undefined>,
  options?: { onlyPreferred?: boolean }
): Promise<string> {
  const { appId, appSecret, oauthRedirectUri } = getWhatsAppConfig();

  const safePreferred = (preferredRedirectUris ?? []).filter(
    (uri): uri is string =>
      typeof uri === "string" &&
      !!uri &&
      !uri.includes("?") &&
      !uri.includes("#") &&
      // Allow our oauth callback path (not legacy typo calback routes).
      (!/\/api\/auth\/whatsapp\//i.test(uri) || /\/api\/auth\/whatsapp\/oauth\/?$/i.test(uri))
  );
  const safeEnv =
    oauthRedirectUri &&
    (!/\/api\/auth\/whatsapp\//i.test(oauthRedirectUri) ||
      /\/api\/auth\/whatsapp\/oauth\/?$/i.test(oauthRedirectUri))
      ? oauthRedirectUri.trim()
      : undefined;

  let candidates: Array<string | null>;
  if (options?.onlyPreferred) {
    candidates = uniqueRedirects(safePreferred.length > 0 ? safePreferred : [safeEnv, WHATSAPP_OAUTH_CALLBACK_URI]);
    if (candidates.length === 0) {
      throw new WhatsAppSignupError(
        "Signup code exchange has no redirect_uri candidates for onlyPreferred mode",
        "code-exchange"
      );
    }
  } else {
    // Controlled callback first, then site, omit, JS SDK internal, env.
    candidates = uniqueRedirects([
      WHATSAPP_OAUTH_CALLBACK_URI,
      safeEnv,
      ...safePreferred,
      ...PREFERRED_SITE_REDIRECTS,
      null,
      FB_JS_SDK_REDIRECT_URI,
    ]);
  }

  let lastStatus = 0;
  let lastBody = "";
  let lastTried: string | null = null;
  const attemptLog: Array<{
    redirectUri: string;
    status: number;
    code?: number;
    error_subcode?: number;
  }> = [];

  for (const redirectUri of candidates) {
    lastTried = redirectUri;
    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      code,
    });
    if (redirectUri) params.set("redirect_uri", redirectUri);

    // Single fetch per attempt — codes are single-use on success only.
    const response = await fetch(`${GRAPH_API_BASE}/oauth/access_token?${params.toString()}`);
    if (response.ok) {
      const data = (await response.json()) as { access_token?: string };
      if (!data.access_token) {
        throw new WhatsAppSignupError(
          "Signup code exchange returned no access token",
          "code-exchange"
        );
      }
      console.log("[whatsapp-oauth] code exchange succeeded", {
        redirectUri: redirectUri ?? "(omitted)",
        priorAttempts: attemptLog,
      });
      return data.access_token;
    }

    lastStatus = response.status;
    lastBody = await response.text();
    const parsedAttempt = parseGraphErrorBody(lastBody);
    attemptLog.push({
      redirectUri: redirectUri ?? "(omitted)",
      status: lastStatus,
      code: parsedAttempt.code,
      error_subcode: parsedAttempt.error_subcode,
    });
    console.error("[whatsapp-oauth] code exchange attempt failed", {
      status: lastStatus,
      redirectUri: redirectUri ?? "(omitted)",
      body: lastBody.slice(0, 500),
    });

    if (isFatalExchangeError(lastBody, parsedAttempt)) {
      break;
    }
    if (!isRetryableRedirectClassError(lastBody, parsedAttempt)) {
      break;
    }
  }

  const parsed = parseGraphErrorBody(lastBody);
  const hint =
    parsed.code === 191 || /domain/i.test(lastBody)
      ? " (Meta code 191: add Exact Valid OAuth Redirect URI https://www.centro-ai.co.il/api/auth/whatsapp/oauth plus https://www.centro-ai.co.il/ ; App Domains centro-ai.co.il + www; Login with JS SDK / Web OAuth ON)"
      : parsed.error_subcode === 36008 || lastBody.includes("36008")
        ? " (36008: exchange redirect_uri must match dialog — use full-page /api/auth/whatsapp/start flow and whitelist https://www.centro-ai.co.il/api/auth/whatsapp/oauth; also verify WHATSAPP_APP_SECRET matches App ID)"
        : lastBody.toLowerCase().includes("secret") || parsed.code === 190
          ? " (check WHATSAPP_APP_SECRET matches App ID on Vercel)"
          : "";

  throw new WhatsAppSignupError(
    `Signup code exchange failed (${lastStatus}): ${lastBody}${hint}`,
    "code-exchange",
    {
      message: parsed.message,
      code: parsed.code,
      error_subcode: parsed.error_subcode,
      tried_redirect_uri: lastTried,
      attempts: attemptLog,
    }
  );
}

function isFatalExchangeError(
  body: string,
  parsed: { message?: string; code?: number; error_subcode?: number }
): boolean {
  // 36008 arrives as Graph code 100 — that MUST remain retryable.
  if (parsed.error_subcode === 36008 || body.includes("36008")) return false;
  if (parsed.code === 191) return false;

  // Invalid secret
  if (parsed.code === 190) return true;
  if (/app secret|invalid client secret/i.test(body)) return true;

  // Code already consumed or expired — further redirect attempts are useless.
  if (/already been used|code has expired|verification code has expired/i.test(body)) {
    return true;
  }

  return false;
}

// Domain/redirect misconfiguration — try the next redirect candidate.
function isRetryableRedirectClassError(
  body: string,
  parsed: { message?: string; code?: number; error_subcode?: number }
): boolean {
  if (parsed.code === 191) return true;
  if (parsed.error_subcode === 36008 || body.includes("36008")) return true;
  if (
    /redirect_uri|can't load url|domain of this url|app domains|identical to the one you used/i.test(
      body
    )
  ) {
    return true;
  }
  return false;
}

function parseGraphErrorBody(body: string): {
  message?: string;
  code?: number;
  error_subcode?: number;
} {
  try {
    const json = JSON.parse(body) as {
      error?: { message?: string; code?: number; error_subcode?: number };
      error_description?: string;
    };
    return {
      message: json.error?.message ?? json.error_description,
      code: json.error?.code,
      error_subcode: json.error?.error_subcode,
    };
  } catch {
    return { message: body.slice(0, 240) };
  }
}

function uniqueRedirects(values: Array<string | null | undefined>): Array<string | null> {
  const result: Array<string | null> = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value === undefined) continue;
    if (value === null) {
      if (!seen.has("__null__")) {
        seen.add("__null__");
        result.push(null);
      }
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
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
    throw new WhatsAppSignupError(
      `Token introspection failed (${response.status}): ${body}`,
      "waba-resolve"
    );
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
    // WA-07: explicit guidance when Config permissions/scopes are wrong.
    throw new WhatsAppSignupError(
      "Exchanged token was not granted access to any WhatsApp Business Account " +
        "(missing whatsapp_business_management/whatsapp_business_messaging granular scope). " +
        "Check the Meta Embedded Signup Configuration permissions.",
      "waba-resolve"
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
//
// WA-01: Step 1 prefers the short-lived Embedded Signup user token (sees
// the new WABA immediately), then falls back to WHATSAPP_SYSTEM_USER_TOKEN
// once asset sharing has completed. Step 2 is an admin operation on the
// app itself (appId|appSecret).
//
// WA-02: Returns false instead of throwing when the WABA-level link
// cannot be established — callers store the connection so a flaky
// subscribe does not undo a completed signup. Inbound messages may stay
// broken until a later reconnect/retry succeeds.
export async function subscribeToWabaWebhooks(
  wabaId: string,
  preferredAccessToken?: string
): Promise<boolean> {
  const { appId, appSecret, systemUserToken, webhookVerifyToken } = getWhatsAppConfig();
  const tokens = uniqueTokens([preferredAccessToken, systemUserToken]);

  let subscribed = false;
  let lastFailure: string | null = null;
  for (const accessToken of tokens) {
    const wabaResponse = await withRetry(() =>
      fetch(`${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    );
    if (wabaResponse.ok) {
      subscribed = true;
      break;
    }
    lastFailure = await wabaResponse.text();
  }

  if (!subscribed) {
    console.error(
      `[whatsapp] WABA-level webhook subscription failed for ${wabaId}` +
        (lastFailure ? `: ${lastFailure}` : "")
    );
    return false;
  }

  if (!webhookVerifyToken) {
    console.error(
      "[whatsapp] WHATSAPP_WEBHOOK_VERIFY_TOKEN not configured — skipping app-level webhook field subscription; inbound messages will not be delivered until this is set and a connection is retried"
    );
    return true;
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

  return true;
}

function uniqueTokens(tokens: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}
