import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

// Phase 7 remediation — matches the timeout already applied to every other
// outbound Meta Graph API call in src/lib/whatsapp/send.ts (15s).
const WHATSAPP_PHONE_NUMBER_REQUEST_TIMEOUT_MS = 15_000;

export class WhatsAppApiError extends Error {
  // Aligns with WhatsAppSignupStep "phone-lookup" for API error responses.
  readonly step = "phone-lookup" as const;

  constructor(message: string) {
    super(message);
    this.name = "WhatsAppApiError";
  }
}

export interface PhoneNumberDetails {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
}

// Resolves the phone number connected to a WABA directly from Meta,
// rather than trusting a phone_number_id reported by the client — the
// WA_EMBEDDED_SIGNUP postMessage that would normally supply one was
// confirmed not to fire for this app/configuration (see
// embeddedSignup.ts's resolveWabaIdFromToken), so the WABA id derived
// there is used to list its numbers instead. A freshly-connected WABA
// has exactly one number in the common case, so the first one returned
// is used.
//
// WA-01: Prefer the short-lived Embedded Signup user token when provided —
// that token is guaranteed to see the WABA just granted. Fall back to the
// shared System User token once Meta has finished sharing the asset with
// Centro's Business Manager.
export async function getFirstPhoneNumberForWaba(
  wabaId: string,
  preferredAccessToken?: string
): Promise<PhoneNumberDetails> {
  const { systemUserToken } = getWhatsAppConfig();
  const tokens = uniqueTokens([preferredAccessToken, systemUserToken]);
  let lastError: WhatsAppApiError | null = null;

  for (const accessToken of tokens) {
    try {
      return await listFirstPhoneNumber(wabaId, accessToken);
    } catch (error) {
      if (error instanceof WhatsAppApiError) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }

  throw (
    lastError ??
    new WhatsAppApiError(`No phone numbers found for WhatsApp Business Account ${wabaId}`)
  );
}

async function listFirstPhoneNumber(wabaId: string, accessToken: string): Promise<PhoneNumberDetails> {
  const response = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/phone_numbers?fields=display_phone_number,verified_name`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(WHATSAPP_PHONE_NUMBER_REQUEST_TIMEOUT_MS),
      }
    )
  );
  if (!response.ok) {
    // WA-04: include Meta's response body (other whatsapp helpers already do).
    const body = await response.text();
    throw new WhatsAppApiError(`Phone number list failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ id: string; display_phone_number: string; verified_name: string }>;
  };
  const numbers = data.data ?? [];
  if (numbers.length === 0) {
    throw new WhatsAppApiError(`No phone numbers found for WhatsApp Business Account ${wabaId}`);
  }
  // Phase 2.2 remediation — this used to silently pick numbers[0]. A WABA
  // with more than one phone number (e.g. one already used for something
  // else on the same Business Manager) would connect Centro to whichever
  // number Meta happened to list first, with no error and no way for the
  // connecting admin to notice except a mismatched display number in
  // Settings later. Fail loud instead — never guess which number the
  // office meant.
  if (numbers.length > 1) {
    throw new WhatsAppApiError(
      `WhatsApp Business Account ${wabaId} has ${numbers.length} phone numbers (${numbers
        .map((n) => n.display_phone_number)
        .join(", ")}) — Centro cannot determine which one to connect automatically. Disconnect the extra number(s) from this WABA, or contact support.`
    );
  }
  const first = numbers[0];
  return {
    id: first.id,
    displayPhoneNumber: first.display_phone_number,
    verifiedName: first.verified_name,
  };
}

// Manual per-organization WhatsApp connection ("בדוק וחבר", owner-only) —
// verifies, against Meta itself, that the Access Token the owner just
// typed in genuinely has access to the given WABA AND that the given
// phone_number_id actually belongs to it, in one call. Deliberately never
// falls back to WHATSAPP_SYSTEM_USER_TOKEN the way getFirstPhoneNumberForWaba
// above does — this function's whole purpose is to validate THIS SPECIFIC
// token, not to succeed via a different one. Returns the real
// display_phone_number/verified_name straight from Meta so the owner never
// has to type (or risk mistyping) them.
export async function getPhoneNumberInWaba(
  wabaId: string,
  phoneNumberId: string,
  accessToken: string
): Promise<PhoneNumberDetails> {
  const response = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/phone_numbers?fields=display_phone_number,verified_name`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(WHATSAPP_PHONE_NUMBER_REQUEST_TIMEOUT_MS),
      }
    )
  );
  if (!response.ok) {
    // Never echo the token itself into the error — only Meta's own
    // structured response, same discipline as every other Graph API error
    // path in this module.
    const body = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new WhatsAppApiError(
        `הטוקן שהוזן אינו תקף, או שאין לו הרשאה על ה-WhatsApp Business Account הזה (${response.status}).`
      );
    }
    throw new WhatsAppApiError(`בדיקת החיבור מול Meta נכשלה (${response.status}): ${body}`);
  }
  const data = (await response.json()) as {
    data?: Array<{ id: string; display_phone_number: string; verified_name: string }>;
  };
  const match = (data.data ?? []).find((n) => n.id === phoneNumberId);
  if (!match) {
    throw new WhatsAppApiError(
      "מספר הטלפון (Phone Number ID) שהוזן לא נמצא תחת ה-WhatsApp Business Account הזה — בדקו שהמזהים תואמים."
    );
  }
  return {
    id: match.id,
    displayPhoneNumber: match.display_phone_number,
    verifiedName: match.verified_name,
  };
}

// Meta "Webhook overrides" — points ONE business phone number at its own
// callback URL, so this organization's inbound events stop arriving on the
// shared app-level endpoint and arrive on a per-number one instead. Meta
// resolves an event's destination phone-number override first, then the
// WABA's, then the app default, so setting this affects only this number
// and never any other tenant on the same App.
//
// Meta performs the usual GET hub.challenge handshake against
// `callbackUrl` DURING this call, which is why the caller must have
// already persisted `verifyToken` (the dynamic route looks it up by
// phoneNumberId to answer that handshake) before calling this.
//
// Returns false rather than throwing on a Meta-side rejection: the
// override is an enhancement, not a requirement — without it the shared
// app-level URL keeps delivering this number's messages exactly as it
// always has, so a failure here must never fail an otherwise-good
// connection. Never echoes either token into an error or a log.
export async function setPhoneNumberWebhookOverride(
  phoneNumberId: string,
  callbackUrl: string,
  verifyToken: string,
  accessToken: string
): Promise<boolean> {
  try {
    const response = await withRetry(() =>
      fetch(`${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          webhook_configuration: {
            override_callback_uri: callbackUrl,
            verify_token: verifyToken,
          },
        }),
        signal: AbortSignal.timeout(WHATSAPP_PHONE_NUMBER_REQUEST_TIMEOUT_MS),
      })
    );
    if (!response.ok) {
      const body = await response.text();
      console.error("[whatsapp] per-number webhook override rejected by Meta", {
        phoneNumberId,
        status: response.status,
        body,
      });
      return false;
    }
    return true;
  } catch (error) {
    console.error("[whatsapp] per-number webhook override request failed", {
      phoneNumberId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
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
 * Confirms an access token was issued by CENTRO's own Meta app.
 *
 * Subscribing a WABA to webhooks attaches the app that ISSUED the token used
 * for the call — never an app named in the request. A token minted inside the
 * client's own Business Manager therefore subscribes that Business Manager's
 * app and leaves Centro's unsubscribed, while every call still reports
 * success. Meta then routes the client's inbound messages to that other app
 * and Centro receives nothing.
 *
 * This is not hypothetical: an office connected this way sent outbound
 * messages perfectly for days (sending only needs a token authorised on the
 * phone number) while every inbound message silently went elsewhere. Checked
 * at connection time so the mismatch is refused up front, with a real
 * explanation, instead of surfacing later as "the client never replies".
 */
export async function describeTokenApp(
  accessToken: string
): Promise<{ matchesCentroApp: boolean; tokenAppId: string | null; error: string | null }> {
  const { appId, appSecret } = getWhatsAppConfig();
  try {
    const url = new URL(`${GRAPH_API_BASE}/debug_token`);
    url.searchParams.set("input_token", accessToken);
    url.searchParams.set("access_token", `${appId}|${appSecret}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const parsed = (await response.json().catch(() => null)) as {
      data?: { app_id?: string };
      error?: { message?: string };
    } | null;
    // Meta answers a foreign token with exactly this, rather than a payload:
    // "The App_id in the input_token did not match the Viewing App".
    if (!response.ok || !parsed?.data?.app_id) {
      return { matchesCentroApp: false, tokenAppId: null, error: parsed?.error?.message ?? "unknown" };
    }
    return {
      matchesCentroApp: parsed.data.app_id === appId,
      tokenAppId: parsed.data.app_id,
      error: null,
    };
  } catch (error) {
    return {
      matchesCentroApp: false,
      tokenAppId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
