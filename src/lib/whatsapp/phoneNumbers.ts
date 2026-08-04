import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

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
      { headers: { Authorization: `Bearer ${accessToken}` } }
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
  const first = data.data?.[0];
  if (!first) {
    throw new WhatsAppApiError(`No phone numbers found for WhatsApp Business Account ${wabaId}`);
  }
  return {
    id: first.id,
    displayPhoneNumber: first.display_phone_number,
    verifiedName: first.verified_name,
  };
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
