import { describe, expect, it } from "vitest";
import {
  PLATFORM_TIME_ZONE,
  formatDate,
  formatDateAndTime,
  formatDateTime,
  formatTime,
} from "./formatDateTime";

/**
 * Regression — every user-facing timestamp was three hours early.
 *
 * "נבדק לאחרונה" for a check run at 12:02 Israel time displayed 09:02,
 * because toLocaleString("he-IL", …) without a `timeZone` formats in the
 * RENDERING process's zone, which is UTC on Vercel. Storing UTC is correct
 * and unchanged; only the display was wrong.
 */

// 2026-08-30T09:02Z is 12:02 in Israel (IDT, +03:00).
const SUMMER = "2026-08-30T09:02:00Z";
// 2026-01-15T09:02Z is 11:02 in Israel (IST, +02:00) — the same offset
// arithmetic would be wrong here, which is why the zone is not a constant.
const WINTER = "2026-01-15T09:02:00Z";

describe("formatting is anchored to a real time zone", () => {
  it("shows Israeli local time, not UTC", () => {
    expect(formatTime(SUMMER, PLATFORM_TIME_ZONE)).toBe("12:02");
  });

  it("follows DST instead of a fixed offset", () => {
    // Summer is +3, winter is +2. A hardcoded "+3 hours" would print 12:02
    // here too, and be an hour wrong for half the year.
    expect(formatTime(SUMMER, PLATFORM_TIME_ZONE)).toBe("12:02");
    expect(formatTime(WINTER, PLATFORM_TIME_ZONE)).toBe("11:02");
  });

  it("would have shown the reported 09:02 had the zone been UTC", () => {
    // Pins the exact bug: the same instant, formatted without the zone.
    expect(formatTime(SUMMER, "UTC")).toBe("09:02");
  });

  it("puts a late-evening instant on the correct DAY", () => {
    // 21:30Z on the 30th is already the 31st in Israel. Formatting in UTC
    // filed such events under the previous day.
    const late = "2026-08-30T21:30:00Z";
    expect(formatDate(late, PLATFORM_TIME_ZONE)).toContain("31");
    expect(formatDate(late, "UTC")).toContain("30");
  });

  it("honours a per-organization zone rather than assuming Israel", () => {
    expect(formatTime(SUMMER, "Europe/London")).toBe("10:02");
    expect(formatTime(SUMMER, "UTC")).toBe("09:02");
  });

  it("defaults to the platform zone when none is supplied", () => {
    expect(formatTime(SUMMER)).toBe(formatTime(SUMMER, PLATFORM_TIME_ZONE));
    expect(formatDateTime(SUMMER)).toContain("12:02");
    expect(formatDateAndTime(SUMMER)).toContain("12:02");
  });

  it("accepts a Date as well as a string", () => {
    expect(formatTime(new Date(SUMMER), PLATFORM_TIME_ZONE)).toBe("12:02");
  });
});
