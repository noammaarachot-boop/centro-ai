import { describe, expect, it } from "vitest";
import { resolveDeferralDate, buildDeferralConfirmationMessage } from "./reminderDeferral";
import { isWithinBusinessHours, zonedDateParts, type BusinessHoursConfig } from "./businessHours";
import type { DeferralDateHint } from "./ai/deferralIntent";

// Reminder deferral by explicit client commitment — resolveDeferralDate is
// pure and deterministic (the AI only ever extracts *which* dating concept
// was used; this function does all the actual arithmetic), so these are
// exact tests against a known reference instant.

const DEFAULT_CONFIG: BusinessHoursConfig = {
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  businessDays: "0,1,2,3,4", // Sun-Thu
  timezone: "Asia/Jerusalem",
};

// 2026-01-11T08:00:00Z is Sunday 10:00 local in Asia/Jerusalem (same known
// reference instant businessHours.test.ts already uses).
const NOW = new Date("2026-01-11T08:00:00Z");

function emptyHint(overrides: Partial<DeferralDateHint>): DeferralDateHint {
  return {
    explicitDay: null,
    explicitMonth: null,
    explicitYear: null,
    weekday: null,
    relativeDays: null,
    relativeWeeks: null,
    namedPeriod: null,
    ...overrides,
  };
}

function weekdayOf(date: Date): number {
  return zonedDateParts(date, "Asia/Jerusalem").weekday;
}

describe("resolveDeferralDate", () => {
  it("'מחר' (relativeDays: 1) resolves to the next calendar day, at business-hours opening", () => {
    const result = resolveDeferralDate(emptyHint({ relativeDays: 1 }), NOW, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 12, hour: 9, minute: 0 });
    expect(result!.humanPhrase).toContain("מחר");
    expect(result!.rolledToNextBusinessDay).toBe(false);
  });

  it("'עוד יומיים' (relativeDays: 2) resolves two calendar days ahead", () => {
    const result = resolveDeferralDate(emptyHint({ relativeDays: 2 }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 13 });
    expect(result!.humanPhrase).toContain("מחרתיים");
  });

  it("'שבוע הבא' (relativeWeeks: 1) resolves exactly 7 days ahead", () => {
    const result = resolveDeferralDate(emptyHint({ relativeWeeks: 1 }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 18 });
    expect(result!.humanPhrase).toContain("בשבוע הבא");
  });

  it("'יום חמישי' (weekday: thursday) resolves to this coming Thursday", () => {
    const result = resolveDeferralDate(emptyHint({ weekday: "thursday" }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts.weekday).toBe(4); // Thursday
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 15 });
    expect(result!.humanPhrase).toBe("יום חמישי");
  });

  it("naming today's own weekday means next week's occurrence, not later today", () => {
    // NOW is itself a Sunday.
    const result = resolveDeferralDate(emptyHint({ weekday: "sunday" }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts.weekday).toBe(0);
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 18 }); // next Sunday, not today
  });

  it("explicit date ('15 באוגוסט', no year) infers the year and never guesses a wrong century", () => {
    const result = resolveDeferralDate(emptyHint({ explicitDay: 15, explicitMonth: 8 }), NOW, DEFAULT_CONFIG);
    expect(result).not.toBeNull();
    expect(result!.dateLabel).toBe("15 באוגוסט");
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    // August 15 hasn't happened yet relative to January 11 the same year.
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(8);
    // Resolves to business-hours opening on whatever weekday Aug 15 2026
    // actually is (rolled forward if it's a closed day) — computed
    // independently here rather than hardcoded, so this test can't be
    // wrong about the calendar.
    const naiveAug15 = new Date(Date.UTC(2026, 7, 15, 6, 0)); // ~9am local, DST-safe enough to check the day
    if (isWithinBusinessHours(DEFAULT_CONFIG, naiveAug15)) {
      expect(parts.day).toBe(15);
      expect(result!.rolledToNextBusinessDay).toBe(false);
    } else {
      expect(result!.rolledToNextBusinessDay).toBe(true);
    }
  });

  it("an explicit date already passed this year rolls to next year", () => {
    // NOW is January 11, 2026 — January 5 has already passed.
    const result = resolveDeferralDate(emptyHint({ explicitDay: 5, explicitMonth: 1 }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts.year).toBe(2027);
  });

  it("a date that falls on a closed day rolls forward to the next business opening", () => {
    // NOW + 5 days = Friday, Jan 16 2026 — closed (Sun-Thu only).
    const result = resolveDeferralDate(emptyHint({ relativeDays: 5 }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(result!.rolledToNextBusinessDay).toBe(true);
    expect(parts.weekday).toBe(0); // rolled to the next Sunday
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 18 });
  });

  it("start_of_next_week resolves to the next Sunday", () => {
    const result = resolveDeferralDate(emptyHint({ namedPeriod: "start_of_next_week" }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts.weekday).toBe(0);
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 18 });
  });

  it("end_of_week resolves to the last allowed business day this week (Thursday)", () => {
    const result = resolveDeferralDate(emptyHint({ namedPeriod: "end_of_week" }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts.weekday).toBe(4);
    expect(parts).toMatchObject({ year: 2026, month: 1, day: 15 });
  });

  it("start_of_month resolves to the 1st of next month", () => {
    const result = resolveDeferralDate(emptyHint({ namedPeriod: "start_of_month" }), NOW, DEFAULT_CONFIG);
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    expect(parts).toMatchObject({ year: 2026, month: 2, day: 1 });
  });

  it("end_of_month labels the last calendar day of the current month, rolled forward to the next business opening if it's a closed day", () => {
    const result = resolveDeferralDate(emptyHint({ namedPeriod: "end_of_month" }), NOW, DEFAULT_CONFIG);
    expect(result!.dateLabel).toBe("31 בינואר");
    const naiveJan31 = new Date(Date.UTC(2026, 0, 31, 6, 0));
    const parts = zonedDateParts(result!.date, "Asia/Jerusalem");
    if (isWithinBusinessHours(DEFAULT_CONFIG, naiveJan31)) {
      expect(parts).toMatchObject({ year: 2026, month: 1, day: 31 });
      expect(result!.rolledToNextBusinessDay).toBe(false);
    } else {
      expect(result!.rolledToNextBusinessDay).toBe(true);
    }
  });

  it("an empty hint (nothing extracted) resolves to null rather than guessing", () => {
    expect(resolveDeferralDate(emptyHint({}), NOW, DEFAULT_CONFIG)).toBeNull();
  });
});

describe("buildDeferralConfirmationMessage", () => {
  it("produces a short natural confirmation naming the resolved date", () => {
    const result = resolveDeferralDate(emptyHint({ weekday: "thursday" }), NOW, DEFAULT_CONFIG)!;
    const message = buildDeferralConfirmationMessage(result);
    expect(message).toContain("יום חמישי");
    expect(message).toContain("בסדר");
  });

  it("notes when the date was rolled forward because the office is closed", () => {
    const result = resolveDeferralDate(emptyHint({ relativeDays: 5 }), NOW, DEFAULT_CONFIG)!;
    const message = buildDeferralConfirmationMessage(result);
    expect(message).toContain("סגור");
  });
});

describe("weekdayOf helper self-check (sanity)", () => {
  it("confirms NOW really is a Sunday", () => {
    expect(weekdayOf(NOW)).toBe(0);
  });
});
