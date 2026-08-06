import { nameMatchScore } from "@/lib/documentIdentityVerification";

/**
 * Multi-signal multi-page detection — "הזיהוי אינו יכול להסתמך רק על חלון
 * זמן של שתי דקות." Whether a newly-arrived document is another page of
 * one already approved is decided from several corroborating signals, not
 * arrival timing alone: a matching reference/contract number, sequential
 * printed page numbers, and the same extracted person/company name all
 * count — each raises confidence independently, so a burst of pages that
 * happens to be a little slower than the old fixed window can still be
 * recognized correctly when the content itself corroborates it, while a
 * same-type document with no corroborating signal at all still needs to
 * arrive soon after to be trusted.
 */

export interface ContinuationSignals {
  personName: string | null;
  companyName: string | null;
  referenceNumber: string | null;
  pageNumberCurrent: number | null;
  pageNumberTotal: number | null;
  receivedAt: Date;
}

// Beyond this, even a perfect content match is no longer trusted as "the
// same burst" — a genuinely late arrival should stand on its own rather
// than silently attach to a page sent an hour ago.
export const MAX_CONTINUATION_WINDOW_MINUTES = 10;
export const MIN_CONTINUATION_CONFIDENCE = 0.5;

// Pure, no DB/IO — directly unit-testable. Returns 0 outside the hard time
// cutoff regardless of any other signal.
export function computeContinuationConfidence(
  prior: ContinuationSignals,
  candidate: ContinuationSignals
): number {
  const minutesApart = (candidate.receivedAt.getTime() - prior.receivedAt.getTime()) / 60000;
  if (minutesApart < 0 || minutesApart > MAX_CONTINUATION_WINDOW_MINUTES) return 0;

  // Baseline for "same requirement match, within the window" plus a time-
  // decay component — matches the old pure-time-window heuristic's own
  // effective range (roughly the first 2 minutes) when no other signal is
  // available at all: 0.1 + timeFactor*0.5 crosses MIN_CONTINUATION_CONFIDENCE
  // (0.5) at exactly the 2-minute mark, then keeps decaying (rather than a
  // hard cliff) so a corroborating signal below can still pull a slower
  // arrival back above the threshold, up to the hard cutoff above.
  const timeFactor = 1 - minutesApart / MAX_CONTINUATION_WINDOW_MINUTES;
  let score = 0.1 + timeFactor * 0.5;

  if (prior.referenceNumber && candidate.referenceNumber && prior.referenceNumber === candidate.referenceNumber) {
    score += 0.4;
  }

  if (
    prior.pageNumberTotal !== null &&
    candidate.pageNumberTotal === prior.pageNumberTotal &&
    prior.pageNumberCurrent !== null &&
    candidate.pageNumberCurrent === prior.pageNumberCurrent + 1
  ) {
    score += 0.4;
  }

  const nameScore = Math.max(
    prior.personName && candidate.personName ? nameMatchScore(prior.personName, candidate.personName) : 0,
    prior.companyName && candidate.companyName ? nameMatchScore(prior.companyName, candidate.companyName) : 0
  );
  score += nameScore * 0.2;

  return Math.min(score, 1);
}
