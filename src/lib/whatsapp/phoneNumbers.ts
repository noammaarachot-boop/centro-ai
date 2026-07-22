import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppApiError extends Error {}

export interface PhoneNumberDetails {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
}

// Confirms a phone_number_id the client reported (via Embedded Signup's
// WA_EMBEDDED_SIGNUP postMessage) is real and resolves the display/
// verified name Step3Connect shows once connected — never trust an id
// from the client without checking it against Meta first.
export async function getPhoneNumberDetails(phoneNumberId: string): Promise<PhoneNumberDetails> {
  const { systemUserToken } = getWhatsAppConfig();
  const response = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${systemUserToken}` } }
    )
  );
  if (!response.ok) {
    throw new WhatsAppApiError(`Phone number lookup failed (${response.status})`);
  }
  const data = (await response.json()) as {
    id: string;
    display_phone_number: string;
    verified_name: string;
  };
  return { id: data.id, displayPhoneNumber: data.display_phone_number, verifiedName: data.verified_name };
}
