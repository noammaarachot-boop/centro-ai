import { describe, expect, it } from "vitest";
import {
  HUMAN_REVIEW_AFTER_DAYS,
  HUMAN_REVIEW_WINDOW_MS,
  currentOverdueOccurrence,
  humanReviewDeadlineFrom,
} from "./policy";
import { OVERDUE_AFTER_DAYS } from "@/lib/elapsedTime";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const at = (ms: number) => T0 + ms;

describe("the review window is one number", () => {
  it("the screen's threshold and the scheduler's are the same value", () => {
    // These were two independent literals. The card measured against one and
    // the scheduler escalated on the other, so changing the rule in one place
    // silently left the other behind.
    expect(OVERDUE_AFTER_DAYS).toBe(HUMAN_REVIEW_AFTER_DAYS);
  });

  it("the deadline is the window added to the start", () => {
    expect(humanReviewDeadlineFrom(new Date(T0)).getTime()).toBe(at(HUMAN_REVIEW_WINDOW_MS));
  });
});

describe("which overdue period a request is in", () => {
  it("is not overdue before the window closes", () => {
    expect(currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS - 1))).toBeNull();
  });

  it("becomes overdue exactly at the boundary", () => {
    expect(currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS))).toEqual(
      new Date(at(HUMAN_REVIEW_WINDOW_MS))
    );
  });

  it("stays on the SAME occurrence for the whole period", () => {
    // This is what makes a dismissal stick: were the occurrence derived from
    // "now" it would differ on every render, so no recorded dismissal could
    // ever match the item a screen was showing.
    const first = currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS));
    const later = currentOverdueOccurrence(T0, at(2 * HUMAN_REVIEW_WINDOW_MS - 1));
    expect(later).toEqual(first);
  });

  it("moves to a NEW occurrence once the next window closes", () => {
    // Being late is not one event: a client silent for three days is a
    // different situation from the same client three days later.
    const first = currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS))!;
    const second = currentOverdueOccurrence(T0, at(2 * HUMAN_REVIEW_WINDOW_MS))!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
    expect(second).toEqual(new Date(at(2 * HUMAN_REVIEW_WINDOW_MS)));
  });

  it("two callers at different instants in one period agree exactly", () => {
    // Two ticks racing on the same request must compute the identical value,
    // which is what makes the dismissal's unique index a real idempotency
    // guarantee rather than a hope.
    const a = currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS + 1));
    const b = currentOverdueOccurrence(T0, at(HUMAN_REVIEW_WINDOW_MS + 60_000));
    expect(a).toEqual(b);
  });

  it("handles an unparseable start rather than inventing a date", () => {
    expect(currentOverdueOccurrence("not a date", T0)).toBeNull();
  });
});
