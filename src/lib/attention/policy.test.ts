import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUMAN_REVIEW_AFTER_DAYS,
  MAX_HUMAN_REVIEW_AFTER_DAYS,
  MIN_HUMAN_REVIEW_AFTER_DAYS,
  currentOverdueOccurrence,
  humanReviewDeadlineFrom,
  humanReviewWindowMs,
  isValidHumanReviewAfterDays,
  resolveHumanReviewAfterDays,
} from "./policy";

const T0 = new Date("2026-01-01T00:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => T0 + ms;

describe("the window is the office's own setting", () => {
  it("1 — defaults to three days, so nothing changes for an office that never sets it", () => {
    expect(DEFAULT_HUMAN_REVIEW_AFTER_DAYS).toBe(3);
    expect(resolveHumanReviewAfterDays(undefined)).toBe(3);
    expect(resolveHumanReviewAfterDays(null)).toBe(3);
    expect(humanReviewWindowMs(null)).toBe(3 * DAY);
  });

  it("uses what the office configured", () => {
    expect(humanReviewWindowMs(1)).toBe(DAY);
    expect(humanReviewWindowMs(10)).toBe(10 * DAY);
    expect(humanReviewDeadlineFrom(new Date(T0), 7).getTime()).toBe(at(7 * DAY));
  });

  it("never resolves to zero, whatever is in the column", () => {
    // A zero window would make every request instantly and permanently
    // overdue — the one outcome a bad stored value must not be able to cause.
    for (const bad of [0, -5, 999, 2.5, Number.NaN, null, undefined, "3" as unknown]) {
      expect(humanReviewWindowMs(bad as number), String(bad)).toBeGreaterThan(0);
    }
  });
});

describe("8 — what may be stored", () => {
  it("accepts the whole allowed range", () => {
    for (const days of [MIN_HUMAN_REVIEW_AFTER_DAYS, 3, 7, 15, MAX_HUMAN_REVIEW_AFTER_DAYS]) {
      expect(isValidHumanReviewAfterDays(days), String(days)).toBe(true);
    }
  });

  it("rejects 0, 31, and anything that is not a whole number of days", () => {
    // No "unlimited": a request nobody is ever told about is not a feature.
    for (const bad of [0, -1, 31, 100, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(isValidHumanReviewAfterDays(bad), String(bad)).toBe(false);
    }
  });

  it("the allowed range is 1 to 30", () => {
    expect(MIN_HUMAN_REVIEW_AFTER_DAYS).toBe(1);
    expect(MAX_HUMAN_REVIEW_AFTER_DAYS).toBe(30);
  });
});

describe("which overdue period a request is in", () => {
  it("2 — an office set to one day raises it after one day", () => {
    expect(currentOverdueOccurrence(T0, 1, at(DAY - 1))).toBeNull();
    expect(currentOverdueOccurrence(T0, 1, at(DAY))).toEqual(new Date(at(DAY)));
  });

  it("3 — an office set to ten days raises nothing before ten days", () => {
    expect(currentOverdueOccurrence(T0, 10, at(3 * DAY))).toBeNull();
    expect(currentOverdueOccurrence(T0, 10, at(9 * DAY))).toBeNull();
    expect(currentOverdueOccurrence(T0, 10, at(10 * DAY))).toEqual(new Date(at(10 * DAY)));
  });

  it("stays on the SAME occurrence for the whole period", () => {
    // This is what makes a dismissal stick: were the occurrence derived from
    // "now" it would differ on every render, so no recorded dismissal could
    // ever match the item a screen was showing.
    const first = currentOverdueOccurrence(T0, 3, at(3 * DAY));
    expect(currentOverdueOccurrence(T0, 3, at(6 * DAY - 1))).toEqual(first);
  });

  it("moves to a NEW occurrence once the next window closes", () => {
    const first = currentOverdueOccurrence(T0, 3, at(3 * DAY))!;
    const second = currentOverdueOccurrence(T0, 3, at(6 * DAY))!;
    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("two callers at different instants in one period agree exactly", () => {
    // Two ticks racing on the same request must compute the identical value,
    // which is what makes the dismissal's unique index a real idempotency
    // guarantee rather than a hope.
    expect(currentOverdueOccurrence(T0, 3, at(3 * DAY + 1))).toEqual(
      currentOverdueOccurrence(T0, 3, at(3 * DAY + 60_000))
    );
  });

  it("changing the setting changes future occurrences consistently", () => {
    // Same request, same instant, two different office policies.
    const strict = currentOverdueOccurrence(T0, 1, at(5 * DAY));
    const patient = currentOverdueOccurrence(T0, 10, at(5 * DAY));
    expect(strict).not.toBeNull();
    expect(patient, "a patient office is simply not overdue yet").toBeNull();
  });

  it("handles an unparseable start rather than inventing a date", () => {
    expect(currentOverdueOccurrence("not a date", 3, T0)).toBeNull();
  });

  it("is measured in elapsed 24h periods, so no timezone can shift it", () => {
    // Deliberately not calendar dates: an elapsed-time boundary is the same
    // instant everywhere, so it cannot drift with the server's zone or DST.
    // The figure a PERSON reads ("עברו 4 ימים") is a separate calendar count
    // rendered in the organization's own zone — see elapsedTime.ts.
    const justBefore = currentOverdueOccurrence(T0, 3, at(3 * DAY - 1));
    const justAfter = currentOverdueOccurrence(T0, 3, at(3 * DAY));
    expect(justBefore).toBeNull();
    expect(justAfter).toEqual(new Date(at(3 * DAY)));
  });
});
