import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppApiError extends Error {}

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
export async function getFirstPhoneNumberForWaba(wabaId: string): Promise<PhoneNumberDetails> {
  const { systemUserToken } = getWhatsAppConfig();
  const response = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/phone_numbers?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${systemUserToken}` } }
    )
  );
  if (!response.ok) {
    throw new WhatsAppApiError(`Phone number list failed (${response.status})`);
  }
  const data = (await response.json()) as {
    data?: Array<{ id: string; display_phone_number: string; verified_name: string }>;
  };
  const first = data.data?.[0];
  if (!first) {
    throw new WhatsAppApiError(`No phone numbers found for WhatsApp Business Account ${wabaId}`);
  }
  return { id: first.id, displayPhoneNumber: first.display_phone_number, verifiedName: first.verified_name };
}
