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

/**
 * Whether two loosely-typed phone inputs are the same real number.
 *
 * Everything that ROUTES by phone already compares normalized numbers —
 * matchClientByPhone in the WhatsApp webhook resolves an inbound message
 * with `toE164(client.phone) === target`. Uniqueness, though, was checked
 * on the raw string, so the two disagreed: "0509998877" and
 * "+972-50-999-8877" are one number to the router and two different
 * clients to the create form. Five rows for one number was reproducible,
 * and an inbound message from it then landed on whichever row the scan
 * happened to reach first.
 *
 * Falls back to exact comparison when either side cannot be normalized,
 * so genuinely unparseable legacy input keeps its previous behaviour
 * instead of being silently collapsed with something it is not.
 */
export function isSamePhoneNumber(a: string, b: string): boolean {
  const normalizedA = toE164(a);
  const normalizedB = toE164(b);
  if (normalizedA && normalizedB) return normalizedA === normalizedB;
  return a.trim() === b.trim();
}
