import { addBusinessDays, businessDaysElapsed, type BusinessHoursConfig } from "@/lib/businessHours";

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

/**
 * The office's open days and zone, for counting.
 *
 * Always produced by resolveScheduleConfig (src/lib/businessHours.ts) from the
 * organization and, where one exists, the request's own service override —
 * the single source of truth for "when is this business open". Nothing here
 * decides that, and nothing here knows which days are a weekend anywhere.
 */
export type HumanReviewSchedule = BusinessHoursConfig;

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

/**
 * The instant a request opened at `start` becomes overdue for this office.
 *
 * Counted in BUSINESS days: a request that goes quiet on Thursday at an
 * office working Sunday to Thursday is not two thirds of the way to needing
 * attention by Saturday night — nobody was there to be answered, and nobody
 * was there to act on it. The days that count, and the zone they are counted
 * in, come from the office's own configuration.
 */
export function humanReviewDeadlineFrom(
  start: Date | string | number,
  configuredDays: number | null | undefined,
  schedule: HumanReviewSchedule
): Date {
  return addBusinessDays(schedule, new Date(start), resolveHumanReviewAfterDays(configuredDays));
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
 * Counted in the office's own BUSINESS days and its own timezone, via the
 * shared addBusinessDays/businessDaysElapsed pair — closed days do not
 * advance the clock, and nothing here knows which weekday is a weekend
 * anywhere in particular.
 *
 * The elapsed figure a PERSON reads ("עברו 4 ימים") remains a plain calendar
 * count in the same zone (src/lib/elapsedTime.ts). The two answer different
 * questions on purpose: how long this has been going on, versus how much of
 * the office's own working time it has consumed.
 */
export function currentOverdueOccurrence(
  openedAt: Date | string | number,
  configuredDays: number | null | undefined,
  schedule: HumanReviewSchedule,
  now: number = Date.now()
): Date | null {
  const opened = new Date(openedAt);
  if (!Number.isFinite(opened.getTime())) return null;

  const windowDays = resolveHumanReviewAfterDays(configuredDays);
  const elapsed = businessDaysElapsed(schedule, opened, new Date(now));

  // How many whole windows of the office's working time have gone by. Zero
  // means it is simply not overdue yet.
  const periodsCrossed = Math.floor(elapsed / windowDays);
  if (periodsCrossed < 1) return null;

  // The boundary instant itself, never `now` — see this function's contract
  // above. addBusinessDays is the exact inverse of the count just made, so
  // this lands on the same instant for every caller inside the same period.
  return addBusinessDays(schedule, opened, periodsCrossed * windowDays);
}
