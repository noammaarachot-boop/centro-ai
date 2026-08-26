/**
 * How long a request has been waiting — decided in ONE place.
 *
 * The same screen used to show two different numbers. The attention panel
 * computed the real age from createdAt ("עברו 7 ימים"), while the summary
 * line above it printed collectionRequests.escalationReason — a string the
 * scheduler had frozen at escalation time, reading "לא ענה — חלפו 3 ימים
 * והבקשה עדיין לא הושלמה". The 3 was never elapsed time at all: it is the
 * THRESHOLD that triggers escalation. Once written it never moved, so on day
 * seven the page contradicted itself.
 *
 * The threshold stays internal. Anything shown to a user is measured here.
 */

/** Escalation fires once a request has gone this long without completing. */
export const OVERDUE_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days elapsed since `from`.
 *
 * `now` is injectable because reading the clock during render is impure —
 * React's lint rule rejects it, and a test cannot pin a value it cannot pass.
 */
export function daysSince(from: Date | string, now: number = Date.now()): number {
  const started = new Date(from).getTime();
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / DAY_MS));
}

/** "היום" / "יום אחד" / "יומיים" / "3 ימים" — Hebrew needs the dual form. */
export function formatDayCount(days: number): string {
  if (days <= 0) return "היום";
  if (days === 1) return "יום אחד";
  if (days === 2) return "יומיים";
  return `${days} ימים`;
}

/** "עברו 7 ימים" — the one phrasing used everywhere. */
export function describeElapsed(days: number): string {
  return days <= 0 ? "נפתחה היום" : `עברו ${formatDayCount(days)}`;
}

/**
 * A stored escalation reason, with any frozen day count removed.
 *
 * Rows already in production carry "לא ענה — חלפו 3 ימים והבקשה עדיין לא
 * הושלמה". Changing what the scheduler writes fixes new escalations only;
 * every existing request would keep contradicting the panel forever. So the
 * stale clause is stripped at display time and the live figure supplied by
 * the caller — the same approach dedupeLabelSegments takes to labels that
 * were stored wrong.
 */
const FROZEN_DAY_CLAUSE = /\s*[—-]?\s*(?:חלפו|עברו)\s+\d+\s+ימים\s*/u;

export function stripFrozenDayCount(reason: string): string {
  if (!FROZEN_DAY_CLAUSE.test(reason)) return reason.trim();
  return reason
    .replace(FROZEN_DAY_CLAUSE, " ")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s*[—-]\s*$/u, "")
    .replace(/^\s*[—-]\s*/u, "")
    .trim();
}

/**
 * The escalation line as a user should read it: why it escalated, plus how
 * long it has ACTUALLY been.
 */
export function describeEscalation(reason: string | null, days: number): string {
  const cleaned = reason ? stripFrozenDayCount(reason) : "";
  const base = cleaned || "הבקשה הוסלמה לבדיקה ידנית";
  return `${base} — ${describeElapsed(days)}`;
}
