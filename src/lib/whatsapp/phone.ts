// Normalizes Centro's loosely-validated phone input (clients.phone/
// leads.phone have no real format constraint — see PHONE_PATTERN in
// src/app/api/contact/route.ts, which only checks "looks like a phone
// number") to E.164, required by every WhatsApp Cloud API call. Applied
// at send-time, not as a one-time data migration — see the WhatsApp
// plan's note on why this is safer (existing data is never touched or
// at risk of corruption).
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

// Centro's own market — a bare local number (05X-XXXXXXX, the
// overwhelmingly common shape in this product's existing data) is
// assumed Israeli, matching how every other loose-phone-input path in
// this codebase already treats unqualified numbers.
const DEFAULT_COUNTRY_CODE = "972";

export function toE164(rawPhone: string): string | null {
  const trimmed = rawPhone.trim();
  const digitsAndPlus = trimmed.replace(/[^\d+]/g, "");
  if (!digitsAndPlus) return null;

  let candidate: string;
  if (digitsAndPlus.startsWith("+")) {
    candidate = digitsAndPlus;
  } else if (digitsAndPlus.startsWith("00")) {
    candidate = `+${digitsAndPlus.slice(2)}`;
  } else if (digitsAndPlus.startsWith("0")) {
    candidate = `+${DEFAULT_COUNTRY_CODE}${digitsAndPlus.slice(1)}`;
  } else if (digitsAndPlus.startsWith(DEFAULT_COUNTRY_CODE)) {
    candidate = `+${digitsAndPlus}`;
  } else {
    candidate = `+${digitsAndPlus}`;
  }

  return E164_PATTERN.test(candidate) ? candidate : null;
}
