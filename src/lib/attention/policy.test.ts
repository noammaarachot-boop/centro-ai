import { describe, expect, it } from "vitest";
import {
  DEFAULT_HUMAN_REVIEW_AFTER_DAYS,
  MAX_HUMAN_REVIEW_AFTER_DAYS,
  MIN_HUMAN_REVIEW_AFTER_DAYS,
  currentOverdueOccurrence,
  humanReviewDeadlineFrom,
  isValidHumanReviewAfterDays,
  resolveHumanReviewAfterDays,
} from "./policy";
import type { BusinessHoursConfig } from "@/lib/businessHours";

/**
 * The window is counted in the office's own WORKING days.
 *
 * "Three days without an answer" means three days the office was actually
 * open. A request that goes quiet on Thursday at an office working Sunday to
 * Thursday is not two thirds of the way to needing attention by Saturday
 * night — nobody was there to be answered, and nobody was there to act.
 *
 * Nothing here knows which weekday is a weekend anywhere: every day that
 * counts comes from the organization's own configuration.
 */

// 2026-01-01 is a Thursday — the exact case in the report.
const THURSDAY = new Date("2026-01-01T10:00:00Z");

const sundayToThursday: BusinessHoursConfig = {
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  businessDays: "0,1,2,3,4",
  timezone: "Asia/Jerusalem",
};

/** An office that never closes — business days and calendar days coincide. */
const everyDay: BusinessHoursConfig = { ...sundayToThursday, businessDays: "0,1,2,3,4,5,6" };

/** A Monday–Friday office, to prove nothing is hard-coded to one weekend. */
const mondayToFriday: BusinessHoursConfig = { ...sundayToThursday, businessDays: "1,2,3,4,5" };

const DAY = 24 * 60 * 60 * 1000;
const daysAfter = (start: Date, n: number) => new Date(start.getTime() + n * DAY).getTime();

describe("how many working days the office allows", () => {
  it("1 — defaults to three, so nothing changes for an office that never sets it", () => {
    expect(DEFAULT_HUMAN_REVIEW_AFTER_DAYS).toBe(3);
    expect(resolveHumanReviewAfterDays(undefined)).toBe(3);
    expect(resolveHumanReviewAfterDays(null)).toBe(3);
  });

  it("8 — accepts the whole allowed range and nothing outside it", () => {
    for (const days of [MIN_HUMAN_REVIEW_AFTER_DAYS, 3, 7, MAX_HUMAN_REVIEW_AFTER_DAYS]) {
      expect(isValidHumanReviewAfterDays(days), String(days)).toBe(true);
    }
    // No "unlimited": a request nobody is ever told about is not a feature.
    for (const bad of [0, -1, 31, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(isValidHumanReviewAfterDays(bad), String(bad)).toBe(false);
    }
    expect(MIN_HUMAN_REVIEW_AFTER_DAYS).toBe(1);
    expect(MAX_HUMAN_REVIEW_AFTER_DAYS).toBe(30);
  });

  it("never resolves to zero, whatever is stored", () => {
    // A zero window would make every request instantly and permanently
    // overdue — the one outcome a bad stored value must not be able to cause.
    for (const bad of [0, -5, 999, 2.5, Number.NaN, null, undefined]) {
      expect(resolveHumanReviewAfterDays(bad as number), String(bad)).toBeGreaterThan(0);
    }
  });
});

describe("the deadline skips days the office is closed", () => {
  it("the reported case: quiet on Thursday, three working days, an office closed Fri/Sat", () => {
    // Fri and Sat do not advance the count, so Sunday, Monday and Tuesday do.
    const deadline = humanReviewDeadlineFrom(THURSDAY, 3, sundayToThursday);

    expect(deadline.getUTCDay(), "Tuesday").toBe(2);
    expect(deadline.toISOString()).toBe("2026-01-06T10:00:00.000Z");
  });

  it("the same office and window, counted straight through, would have said Sunday", () => {
    // What the previous 24-hour-block implementation produced — kept as the
    // contrast the whole change is about.
    expect(new Date(daysAfter(THURSDAY, 3)).getUTCDay(), "Sunday").toBe(0);
  });

  it("nothing is hard-coded to one weekend — a Mon–Fri office skips Sat/Sun instead", () => {
    // Same Thursday start: Fri counts (1), Sat and Sun do not, Mon (2), Tue (3).
    const deadline = humanReviewDeadlineFrom(THURSDAY, 3, mondayToFriday);

    expect(deadline.toISOString()).toBe("2026-01-06T10:00:00.000Z");
    expect(deadline.getUTCDay(), "Tuesday").toBe(2);
  });

  it("an office open only one day a week waits whole weeks per day", () => {
    const sundaysOnly: BusinessHoursConfig = { ...sundayToThursday, businessDays: "0" };

    const deadline = humanReviewDeadlineFrom(THURSDAY, 2, sundaysOnly);

    expect(deadline.getUTCDay(), "still a Sunday").toBe(0);
    // Two Sundays after that Thursday: 4 Jan, then 11 Jan.
    expect(deadline.toISOString()).toBe("2026-01-11T10:00:00.000Z");
  });

  it("an office open every day counts plain calendar days", () => {
    expect(humanReviewDeadlineFrom(THURSDAY, 3, everyDay).getTime()).toBe(daysAfter(THURSDAY, 3));
  });

  it("keeps the time of day, so the window stays a whole number of days", () => {
    const deadline = humanReviewDeadlineFrom(THURSDAY, 3, sundayToThursday);
    expect(deadline.getUTCHours()).toBe(THURSDAY.getUTCHours());
    expect(deadline.getUTCMinutes()).toBe(THURSDAY.getUTCMinutes());
  });

  it("a configuration with no open days still moves, rather than freezing forever", () => {
    const broken: BusinessHoursConfig = { ...sundayToThursday, businessDays: "" };

    // Degenerate, but a request must never become permanently unable to reach
    // attention because of a bad row.
    expect(humanReviewDeadlineFrom(THURSDAY, 3, broken).getTime()).toBe(daysAfter(THURSDAY, 3));
  });
});

describe("which overdue period a request is in", () => {
  const occurrence = (now: number, days = 3, schedule = sundayToThursday) =>
    currentOverdueOccurrence(THURSDAY, days, schedule, now);

  it("is not overdue while the weekend is passing", () => {
    // Saturday: two calendar days on, but no working day has gone by yet.
    expect(occurrence(daysAfter(THURSDAY, 2))).toBeNull();
    // Sunday and Monday: one and two working days — still short of three.
    expect(occurrence(daysAfter(THURSDAY, 3))).toBeNull();
    expect(occurrence(daysAfter(THURSDAY, 4))).toBeNull();
  });

  it("becomes overdue exactly at the third working day", () => {
    expect(occurrence(daysAfter(THURSDAY, 5))).toEqual(new Date("2026-01-06T10:00:00.000Z"));
  });

  it("2 — an office set to one working day raises it on the next open day", () => {
    // Friday and Saturday are closed, so Sunday is the first working day.
    expect(occurrence(daysAfter(THURSDAY, 2), 1)).toBeNull();
    expect(occurrence(daysAfter(THURSDAY, 3), 1)).toEqual(new Date("2026-01-04T10:00:00.000Z"));
  });

  it("3 — an office set to ten working days raises nothing at nine", () => {
    // Nine working days from that Thursday lands well over a fortnight later.
    expect(occurrence(daysAfter(THURSDAY, 13), 10)).toBeNull();
    expect(occurrence(daysAfter(THURSDAY, 20), 10)).not.toBeNull();
  });

  it("stays on the SAME occurrence for the whole period", () => {
    // This is what makes a dismissal stick: were the occurrence derived from
    // "now" it would differ on every render, so no recorded dismissal could
    // ever match the item a screen was showing.
    const first = occurrence(daysAfter(THURSDAY, 5));
    expect(occurrence(daysAfter(THURSDAY, 6))).toEqual(first);
    expect(occurrence(daysAfter(THURSDAY, 5) + 60_000)).toEqual(first);
  });

  it("moves to a NEW occurrence once the next window of working days closes", () => {
    const first = occurrence(daysAfter(THURSDAY, 5))!;
    const second = occurrence(daysAfter(THURSDAY, 12))!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("two callers inside one period agree exactly", () => {
    // Two ticks racing on the same request must compute the identical value,
    // which is what makes the dismissal's unique index a real idempotency
    // guarantee rather than a hope.
    expect(occurrence(daysAfter(THURSDAY, 5) + 1)).toEqual(occurrence(daysAfter(THURSDAY, 6) - 1));
  });

  it("the deadline and the occurrence never disagree", () => {
    // businessDaysElapsed and addBusinessDays are defined against each other;
    // if they drifted, a request could be past its deadline while still
    // reporting as not yet due.
    for (const days of [1, 2, 3, 5, 10]) {
      const deadline = humanReviewDeadlineFrom(THURSDAY, days, sundayToThursday);
      expect(occurrence(deadline.getTime() - 1, days), `${days}d, just before`).toBeNull();
      expect(occurrence(deadline.getTime(), days), `${days}d, exactly at`).toEqual(deadline);
    }
  });

  it("changing the setting changes future derivations consistently", () => {
    const now = daysAfter(THURSDAY, 5);
    expect(occurrence(now, 1), "an impatient office").not.toBeNull();
    expect(occurrence(now, 20), "a patient one, same request, same instant").toBeNull();
  });

  it("handles an unparseable start rather than inventing a date", () => {
    expect(currentOverdueOccurrence("not a date", 3, sundayToThursday, THURSDAY.getTime())).toBeNull();
  });
});

describe("counted in the office's own zone, across DST", () => {
  const jerusalem: BusinessHoursConfig = { ...everyDay, timezone: "Asia/Jerusalem" };
  const utc: BusinessHoursConfig = { ...everyDay, timezone: "UTC" };

  it("the office's zone decides which day a request opened on", () => {
    // 22:00 UTC on Thursday is already Friday in Jerusalem. An office there
    // must count from ITS Friday, not from the server's Thursday.
    const lateThursdayUtc = new Date("2026-01-01T22:00:00Z");
    const sundayToThursdayJerusalem: BusinessHoursConfig = {
      ...jerusalem,
      businessDays: "0,1,2,3,4",
    };
    const sundayToThursdayUtc: BusinessHoursConfig = { ...utc, businessDays: "0,1,2,3,4" };

    const inJerusalem = humanReviewDeadlineFrom(lateThursdayUtc, 1, sundayToThursdayJerusalem);
    const inUtc = humanReviewDeadlineFrom(lateThursdayUtc, 1, sundayToThursdayUtc);

    // The SAME instant, the same office days, two different answers — because
    // the two offices are not on the same date. In Jerusalem it is already
    // Friday, so only Saturday is skipped before Sunday.
    expect(inJerusalem.toISOString()).toBe("2026-01-03T22:00:00.000Z");
    // In UTC it is still Thursday, so both Friday and Saturday are skipped.
    expect(inUtc.toISOString()).toBe("2026-01-04T22:00:00.000Z");
    expect(inJerusalem.getTime(), "the zone is not decoration").not.toBe(inUtc.getTime());
  });

  it("a window spanning a DST change keeps the same time of day", () => {
    // Israel moves to summer time on 2026-03-27. A window that crosses it
    // must still land at the same wall-clock time the request opened at —
    // the elapsed milliseconds differ by an hour, and that is correct for a
    // window a person expresses in days.
    const beforeChange = new Date("2026-03-25T08:00:00Z"); // 10:00 local, UTC+2

    const deadline = humanReviewDeadlineFrom(beforeChange, 5, jerusalem);

    // 2026-03-30, now UTC+3, so 10:00 local is 07:00Z — an hour earlier in
    // UTC than a flat 5 x 24h would have produced.
    expect(deadline.toISOString()).toBe("2026-03-30T07:00:00.000Z");
    const flatElapsed = beforeChange.getTime() + 5 * DAY;
    expect(deadline.getTime(), "not simply five 24-hour blocks").not.toBe(flatElapsed);
  });

  it("the occurrence stays consistent with the deadline across DST", () => {
    const beforeChange = new Date("2026-03-25T08:00:00Z");
    const deadline = humanReviewDeadlineFrom(beforeChange, 5, jerusalem);

    expect(
      currentOverdueOccurrence(beforeChange, 5, jerusalem, deadline.getTime() - 1),
      "not yet due one millisecond before its own deadline"
    ).toBeNull();
    expect(currentOverdueOccurrence(beforeChange, 5, jerusalem, deadline.getTime())).toEqual(deadline);
  });
});
