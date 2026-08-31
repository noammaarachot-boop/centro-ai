import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";
import { WHATSAPP_HARDCODE_ENABLED, WHATSAPP_HARDCODED } from "./hardcodedConfig";
import { WEBHOOK_CALLBACK_URL } from "./webhookUrls";

// Phase 7 remediation — matches the timeout already applied to every other
// outbound Meta Graph API call in src/lib/whatsapp/send.ts (15s). This is
// an admin-initiated onboarding flow, not a hot request path, but a hung
// call here previously had no bound of its own.
const WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS = 15_000;

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
  /**
   * Which account/number the operator actually picked versus the one the
   * organization is already connected to. Ids only — no secrets — so the
   * owner console can say what went wrong instead of "signup failed".
   */
  selectedWabaId?: string;
  expectedWabaId?: string;
  expectedPhoneNumberId?: string;
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

const PREFERRED_SITE_REDIRECTS = [
  "https://www.centro-ai.co.il/",
  "https://www.centro-ai.co.il",
] as const;

function siteRedirectCandidates(): string[] {
  if (WHATSAPP_HARDCODE_ENABLED) {
    return [
      WHATSAPP_HARDCODED.siteOriginTrailing,
      WHATSAPP_HARDCODED.siteOrigin,
      WHATSAPP_HARDCODED.oauthRedirectUri,
    ];
  }
  return [...PREFERRED_SITE_REDIRECTS];
}

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
    // Live after App Domains fixed: site + omit all return pure 36008.
    // FB.login often binds login_success.html (try it once domains allow).
    // Also try full-page oauth callback URI.
    candidates = uniqueRedirects([
      ...safePreferred,
      FB_JS_SDK_REDIRECT_URI,
      WHATSAPP_HARDCODE_ENABLED
        ? WHATSAPP_HARDCODED.oauthCallbackUri
        : WHATSAPP_OAUTH_CALLBACK_URI,
      ...siteRedirectCandidates(),
      safeEnv,
      null,
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
    message?: string;
  }> = [];

  for (const redirectUri of candidates) {
    lastTried = redirectUri;
    const params = new URLSearchParams({
      client_id: appId,
      client_secret: appSecret,
      code,
      // Some Meta samples include this; harmless for Graph.
      grant_type: "authorization_code",
    });
    if (redirectUri) params.set("redirect_uri", redirectUri);

    // POST body exchange (GET query also works; POST is preferred for long codes).
    const response = await fetch(`${GRAPH_API_BASE}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS),
    });
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
      message: parsedAttempt.message,
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

  // If every try is 36008 with our exact site URI, secret mismatch is common.
  let secretMatchesApp: boolean | null = null;
  try {
    const probe = await fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(appId)}?fields=id&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`,
      { signal: AbortSignal.timeout(WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS) }
    );
    secretMatchesApp = probe.ok;
  } catch {
    secretMatchesApp = null;
  }

  // Prefer the most actionable attempt (site origin 191 > obscure last try).
  const preferredFail =
    attemptLog.find(
      (a) =>
        a.code === 191 &&
        typeof a.redirectUri === "string" &&
        a.redirectUri.includes("centro-ai.co.il")
    ) ??
    attemptLog.find((a) => a.error_subcode === 36008) ??
    attemptLog[attemptLog.length - 1];

  const parsed = parseGraphErrorBody(lastBody);
  const publicMessage = preferredFail?.message ?? parsed.message;
  const publicCode = preferredFail?.code ?? parsed.code;
  const publicSub = preferredFail?.error_subcode ?? parsed.error_subcode;

  const hint =
    secretMatchesApp === false
      ? " (WHATSAPP_APP_SECRET does not match App ID — re-copy App Secret from Meta Basic settings into Vercel for this exact App ID)"
      : publicCode === 191 || /domain/i.test(publicMessage ?? lastBody)
        ? " (Meta 191: Settings → Basic → App Domains must list centro-ai.co.il AND www.centro-ai.co.il (no https://). Add Website platform Site URL https://www.centro-ai.co.il/. Valid OAuth Redirect URIs: https://www.centro-ai.co.il/ and https://www.centro-ai.co.il. Save. Login with JavaScript SDK = Yes.)"
        : publicSub === 36008 || lastBody.includes("36008")
          ? " (36008: dialog redirect_uri != exchange. Add https://www.facebook.com/connect/login_success.html AND https://www.centro-ai.co.il/ to Valid OAuth Redirect URIs. Prefer full-page connect if popup keeps failing.)"
          : lastBody.toLowerCase().includes("secret") || publicCode === 190
            ? " (check WHATSAPP_APP_SECRET matches App ID on Vercel)"
            : "";

  throw new WhatsAppSignupError(
    `Signup code exchange failed (${lastStatus}): ${lastBody}${hint}`,
    "code-exchange",
    {
      message: publicMessage,
      code: publicCode,
      error_subcode: publicSub,
      tried_redirect_uri: preferredFail?.redirectUri ?? lastTried,
      attempts: attemptLog.map(({ redirectUri, status, code, error_subcode }) => ({
        redirectUri,
        status,
        code,
        error_subcode,
      })),
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

// Exported for reuse by send.ts's own error logging — a single place that
// knows how to reduce Meta's raw error body (which can echo back request
// content — recipient numbers, template parameters) down to just the
// structured fields worth logging.
export function parseGraphErrorBody(body: string): {
  message?: string;
  code?: number;
  error_subcode?: number;
  type?: string;
  /** Meta's own support reference — the only way to have them trace a call. */
  fbtrace_id?: string;
  /** e.g. {messaging_product, details} on a send rejection. */
  error_data?: unknown;
} {
  try {
    const json = JSON.parse(body) as {
      error?: {
        message?: string;
        code?: number;
        error_subcode?: number;
        type?: string;
        fbtrace_id?: string;
        error_data?: unknown;
      };
      error_description?: string;
    };
    return {
      message: json.error?.message ?? json.error_description,
      code: json.error?.code,
      // Subcode is what separates otherwise identical failures: code 100 with
      // subcode 33 is "this object is not visible to this token" (a
      // permissions/wrong-account problem), while code 100 with no subcode on
      // /messages is a bad parameter such as a template name the WABA does
      // not have. Discarding it made those indistinguishable in the logs.
      error_subcode: json.error?.error_subcode,
      type: json.error?.type,
      fbtrace_id: json.error?.fbtrace_id,
      error_data: json.error?.error_data,
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
  const response = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/debug_token?${params.toString()}`, {
      signal: AbortSignal.timeout(WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS),
    })
  );
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
  const targetIds =
    scopes.find((scope) => scope.scope === "whatsapp_business_management")?.target_ids ??
    scopes.find((scope) => scope.scope === "whatsapp_business_messaging")?.target_ids ??
    [];
  if (targetIds.length === 0) {
    // WA-07: explicit guidance when Config permissions/scopes are wrong.
    throw new WhatsAppSignupError(
      "Exchanged token was not granted access to any WhatsApp Business Account " +
        "(missing whatsapp_business_management/whatsapp_business_messaging granular scope). " +
        "Check the Meta Embedded Signup Configuration permissions.",
      "waba-resolve"
    );
  }
  // Phase 2.2 remediation — this used to silently pick target_ids[0]. A
  // signing admin whose Meta identity has access to more than one WABA
  // (e.g. an accountant/agency managing several clients' Business
  // Managers) would silently connect Centro to whichever WABA Meta
  // happened to list first. Fail loud instead — never guess which
  // business the office meant to connect.
  if (targetIds.length > 1) {
    throw new WhatsAppSignupError(
      `This Meta account has access to ${targetIds.length} WhatsApp Business Accounts — Centro cannot determine which one to connect automatically. Complete Embedded Signup with an account that only has access to the one Business Account you want to connect.`,
      "waba-resolve"
    );
  }
  return targetIds[0];
}

// Centro's fixed production callback URL now lives in webhookUrls.ts, so
// the per-number override (buildPhoneNumberWebhookUrl) derives from the
// exact same origin instead of repeating the domain. Must still match the
// Callback URL verified in the Meta App Dashboard's WhatsApp
// Configuration; Meta rejects a mismatched callback_url on the app-level
// subscription call below.

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
//
// `allowSharedTokenFallback` — the WA-01 fallback above is correct ONLY
// for Embedded Signup, where the organization has no token of its own and
// the shared system-user token genuinely covers its WABA. A manually
// connected organization has its own credentials, and falling back there
// is actively harmful: it would either fail anyway (the shared token has
// no access to that office's WABA) or, worse, appear to succeed while
// hiding that the office's own token lacks the permission it needs —
// exactly the "submission worked but sending later fails" split this must
// prevent. Such callers pass false and get a truthful failure instead.
export async function subscribeToWabaWebhooks(
  wabaId: string,
  preferredAccessToken?: string,
  options?: { allowSharedTokenFallback?: boolean }
): Promise<boolean> {
  const { appId, appSecret, systemUserToken, webhookVerifyToken } = getWhatsAppConfig();
  const allowFallback = options?.allowSharedTokenFallback ?? true;

  // CENTRO's own token first, then the organization's.
  //
  // POST /{waba}/subscribed_apps subscribes the app that ISSUED the token —
  // it has no parameter naming an app. The organization's own token was
  // tried first, returned 200 (it happily subscribed the app that minted
  // it) and the loop broke on that success, so Centro's app was never
  // attached. Meta then delivered that office's inbound messages to the
  // other app while outbound kept working, because sending needs no
  // subscription at all. Only a Centro-app-issued token can subscribe
  // Centro's app, and the shared System User token is exactly that.
  //
  // The organization's token stays in the list because in Embedded Signup
  // it IS Centro-app-issued (it comes from exchanging Centro's own signup
  // code), and there it may reach a WABA the shared System User cannot.
  const tokens = uniqueTokens([
    ...(allowFallback ? [systemUserToken] : []),
    preferredAccessToken,
  ]);

  let subscribed = false;
  let lastFailure: string | null = null;
  for (const accessToken of tokens) {
    const wabaResponse = await withRetry(() =>
      fetch(`${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS),
      })
    );
    if (!wabaResponse.ok) {
      lastFailure = await wabaResponse.text();
      continue;
    }
    // A 200 only means SOME app was subscribed. Read back whether it was
    // ours before believing it — that distinction is the whole bug.
    const check = await verifyCentroAppSubscribed(wabaId, accessToken);
    if (check.subscribed) {
      subscribed = true;
      break;
    }
    lastFailure =
      `subscribe returned ok but Centro's app (${appId}) is not attached; ` +
      `subscribed apps: ${check.subscribedAppIds.join(", ") || "none"}` +
      (check.error ? ` (${check.error})` : "");
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
    fetch(`${GRAPH_API_BASE}/${appId}/subscriptions`, {
      method: "POST",
      body: fieldParams,
      signal: AbortSignal.timeout(WHATSAPP_SIGNUP_REQUEST_TIMEOUT_MS),
    })
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

/**
 * Reads back whether CENTRO's app is actually subscribed to this WABA.
 *
 * subscribeToWabaWebhooks reports whether the POST succeeded, which is not
 * the same question. POST /{waba}/subscribed_apps subscribes the app that
 * ISSUED the token, so a token minted under a different app returns a
 * perfectly successful response while Centro's app is never attached — and
 * Meta then delivers that office's inbound messages to the other app. That
 * exact situation ran undetected in production: outbound worked for days
 * (sending needs no app subscription) while every reply went elsewhere.
 *
 * The WABA still belongs to the organization throughout. This only confirms
 * that Centro's app has been authorised to receive its webhooks.
 */
export async function verifyCentroAppSubscribed(
  wabaId: string,
  accessToken: string
): Promise<{ subscribed: boolean; subscribedAppIds: string[]; error: string | null }> {
  const { appId } = getWhatsAppConfig();
  try {
    const response = await fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/subscribed_apps`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      }
    );
    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ whatsapp_business_api_data?: { id?: string } }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      return { subscribed: false, subscribedAppIds: [], error: body?.error?.message ?? `HTTP ${response.status}` };
    }
    const ids = (body?.data ?? [])
      .map((row) => row.whatsapp_business_api_data?.id)
      .filter((id): id is string => typeof id === "string");
    return { subscribed: ids.includes(appId), subscribedAppIds: ids, error: null };
  } catch (error) {
    return {
      subscribed: false,
      subscribedAppIds: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
