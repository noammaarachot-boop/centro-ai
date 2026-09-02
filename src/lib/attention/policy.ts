/**
 * How long the office gives a client before a human should step in.
 *
 * This number used to exist twice, independently: OVERDUE_AFTER_DAYS in
 * elapsedTime.ts decided whether the request CARD said "דורש טיפול", and a
 * bare `3 * 24 * 60 * 60 * 1000` in collectionRequestStateMachine.ts decided
 * when the SCHEDULER escalated. Two copies of one policy meant the screen and
 * the engine could disagree about the same request, and changing the rule
 * meant finding both.
 *
 * It lives here once. There is deliberately no per-organization setting yet —
 * inventing one would be a product decision, not a refactor — but everything
 * now reads a single value, so introducing one later is a change to this file
 * rather than a hunt through the codebase.
 */

/** A client has this many days to respond before the office is asked to act. */
export const HUMAN_REVIEW_AFTER_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export const HUMAN_REVIEW_WINDOW_MS = HUMAN_REVIEW_AFTER_DAYS * DAY_MS;

/** The instant a request opened at `start` becomes overdue. */
export function humanReviewDeadlineFrom(start: Date | string | number): Date {
  return new Date(new Date(start).getTime() + HUMAN_REVIEW_WINDOW_MS);
}

/**
 * WHICH overdue period a request is currently in, as a stable instant — or
 * null if it is not overdue at all.
 *
 * This is the "occurrence" that attention dismissals are versioned against,
 * and it is why "טופל" cannot silence the problem forever. Being overdue is
 * not one event: a client who has been silent for three days is a different
 * situation from the same client three days later, and an office that dealt
 * with the first is entitled to hear about the second.
 *
 * So the window re-arms. The occurrence is the most recent deadline boundary
 * actually crossed — opened+3d, then opened+6d, then opened+9d — which makes
 * dismissal mean "I have handled THIS period" rather than "never mention this
 * request again".
 *
 * Deliberately a boundary instant and never `now`: a value derived from the
 * clock would differ on every render, so a dismissal recorded by one request
 * could never match the occurrence another request was looking at, and no
 * "טופל" would ever stick. Two ticks racing on the same request compute the
 * identical instant here, which is what makes the dismissal's unique index a
 * real idempotency guarantee rather than a hope.
 */
export function currentOverdueOccurrence(
  openedAt: Date | string | number,
  now: number = Date.now()
): Date | null {
  const opened = new Date(openedAt).getTime();
  if (!Number.isFinite(opened)) return null;

  const elapsed = now - opened;
  if (elapsed < HUMAN_REVIEW_WINDOW_MS) return null;

  const periodsCrossed = Math.floor(elapsed / HUMAN_REVIEW_WINDOW_MS);
  return new Date(opened + periodsCrossed * HUMAN_REVIEW_WINDOW_MS);
}
