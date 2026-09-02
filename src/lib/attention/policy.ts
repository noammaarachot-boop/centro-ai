/**
 * How long the office gives a client before a human should step in.
 *
 * This number used to be a literal `3`, and it existed twice independently:
 * one copy decided whether the request CARD said "דורש טיפול", another decided
 * when the SCHEDULER escalated. Two copies of one rule meant the screen and
 * the engine could disagree about the same request.
 *
 * It is now the organization's own setting — `organizations.humanReviewAfterDays`
 * — and this module is the only place that knows what to do with it. Nothing
 * else may hold its own idea of the threshold.
 *
 * There is no per-service override. Reminder cadence has one because different
 * kinds of work are chased at different rhythms; "when do I want to be told
 * nobody answered" is a property of how the OFFICE works, and giving it a
 * second place to be configured would recreate exactly the divergence this
 * whole area just stopped having.
 */

/**
 * Mirrors the column default in src/db/schema.ts.
 *
 * Used only where an organization's row genuinely is not available — never as
 * a convenient stand-in for looking the real value up.
 */
export const DEFAULT_HUMAN_REVIEW_AFTER_DAYS = 3;

/** Anything below a day makes "days" meaningless; anything past a month is abandonment. */
export const MIN_HUMAN_REVIEW_AFTER_DAYS = 1;
export const MAX_HUMAN_REVIEW_AFTER_DAYS = 30;

/** What the UI suggests, without preventing anything else in range. */
export const RECOMMENDED_HUMAN_REVIEW_AFTER_DAYS = { min: 3, max: 7 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a submitted value may be stored.
 *
 * Deliberately a predicate rather than a clamp: silently "fixing" 45 into 30
 * saves something the office did not ask for and never tells them. Callers
 * validate and reject, matching how business hours are already handled.
 */
export function isValidHumanReviewAfterDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_HUMAN_REVIEW_AFTER_DAYS &&
    value <= MAX_HUMAN_REVIEW_AFTER_DAYS
  );
}

/**
 * The stored setting, made safe to compute with.
 *
 * A row written before this column existed, or one somehow out of range, must
 * never produce a nonsensical window (a zero would make every request
 * instantly and permanently overdue). Falls back to the same default the
 * column carries.
 */
export function resolveHumanReviewAfterDays(configured: number | null | undefined): number {
  return isValidHumanReviewAfterDays(configured) ? configured : DEFAULT_HUMAN_REVIEW_AFTER_DAYS;
}

export function humanReviewWindowMs(configuredDays: number | null | undefined): number {
  return resolveHumanReviewAfterDays(configuredDays) * DAY_MS;
}

/** The instant a request opened at `start` becomes overdue for this office. */
export function humanReviewDeadlineFrom(
  start: Date | string | number,
  configuredDays: number | null | undefined
): Date {
  return new Date(new Date(start).getTime() + humanReviewWindowMs(configuredDays));
}

/**
 * WHICH overdue period a request is currently in, as a stable instant — or
 * null if it is not overdue at all.
 *
 * This is the "occurrence" that attention dismissals are versioned against,
 * and it is why "טופל" cannot silence the problem forever. Being overdue is
 * not one event: a client who has been silent for the full window is a
 * different situation from the same client a window later, and an office that
 * dealt with the first is entitled to hear about the second.
 *
 * So the window re-arms: the occurrence is the most recent deadline boundary
 * actually crossed — opened+N, then opened+2N — which makes dismissal mean "I
 * have handled THIS period" rather than "never mention this request again".
 *
 * Deliberately a boundary instant and never `now`: a value derived from the
 * clock would differ on every render, so a dismissal recorded by one screen
 * could never match the occurrence another was looking at, and no "טופל" would
 * ever stick. Two ticks racing on the same request compute the identical
 * instant here, which is what makes the dismissal's unique index a real
 * idempotency guarantee rather than a hope.
 *
 * Measured in elapsed 24-hour periods from when the request opened, NOT in
 * calendar dates — see this module's own tests. That makes it independent of
 * any timezone, so it cannot drift with the server's zone or with DST. The
 * elapsed figure a PERSON reads ("עברו 4 ימים") is a separate, calendar-based
 * count rendered in the organization's own zone by src/lib/elapsedTime.ts.
 */
export function currentOverdueOccurrence(
  openedAt: Date | string | number,
  configuredDays: number | null | undefined,
  now: number = Date.now()
): Date | null {
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return null;

  const windowMs = humanReviewWindowMs(configuredDays);
  const elapsed = now - opened;
  if (elapsed < windowMs) return null;

  const periodsCrossed = Math.floor(elapsed / windowMs);
  return new Date(opened + periodsCrossed * windowMs);
}
