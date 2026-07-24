import { he, type OwnerMessageKey } from "./messages/he";

// Hardcoded to "he" for V1 — no locale switcher, no cookie-based detection.
// Every owner-dashboard string still goes through this function rather
// than being written inline, so adding a real locale (an "en" sibling
// catalog + a resolution mechanism here) later is additive, not a rewrite.
const activeCatalog: Record<OwnerMessageKey, string> = he;

export function t(key: OwnerMessageKey, params?: Record<string, string | number>): string {
  const template = activeCatalog[key];
  if (!params) return template;
  return Object.entries(params).reduce(
    (result, [paramKey, value]) => result.replaceAll(`{{${paramKey}}}`, String(value)),
    template
  );
}
