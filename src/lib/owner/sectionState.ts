// Accordion open/closed state for the owner console's organization page.
//
// Extracted so the rule can be tested directly: the USER's stored choice
// always wins, and `defaultOpen` only applies before they have made one.
// That is what stops a section the user closed from re-opening itself
// after a server action or a refresh.

/** Stable, per-organization, per-section identity. */
export function sectionStorageKey(organizationId: string, section: string): string {
  return `owner:org:${organizationId}:${section}`;
}

export function serializeSectionState(open: boolean): string {
  return open ? "1" : "0";
}

/**
 * `stored` is whatever localStorage holds for this section: null when the
 * user has never toggled it. Anything other than the two known values is
 * treated as "no preference" rather than being coerced into one.
 */
export function resolveSectionOpen(stored: string | null, defaultOpen: boolean): boolean {
  if (stored === "1") return true;
  if (stored === "0") return false;
  return defaultOpen;
}
