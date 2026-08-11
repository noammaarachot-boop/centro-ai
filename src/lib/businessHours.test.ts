import { describe, expect, it } from "vitest";
import { endOfTodayOrNextOpen, isWithinBusinessHours, nextBusinessOpenTime, type BusinessHoursConfig } from "./businessHours";

const DEFAULT_CONFIG: BusinessHoursConfig = {
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  businessDays: "0,1,2,3,4", // Sun-Thu
  timezone: "Asia/Jerusalem",
};

function localParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return { weekday: parts.weekday, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

describe("isWithinBusinessHours", () => {
  it("evaluates in the organization's own timezone, not server-local/UTC time (winter, UTC+2)", () => {
    // 2026-01-11T08:00:00Z is Sunday 10:00 in Asia/Jerusalem (within 09:00-18:00) —
    // but reads as 08:00 in raw UTC, which a naive server-local/UTC hour check
    // (the pre-fix behavior) would wrongly deny. This is the regression test
    // for that exact bug.
    const at = new Date("2026-01-11T08:00:00Z");
    expect(isWithinBusinessHours(DEFAULT_CONFIG, at)).toBe(true);
  });

  it("evaluates correctly across the summer DST offset too (UTC+3)", () => {
    // 2026-07-12T07:00:00Z is Sunday 10:00 in Asia/Jerusalem during DST — a
    // different UTC offset than the winter case above, same correct result.
    const at = new Date("2026-07-12T07:00:00Z");
    expect(isWithinBusinessHours(DEFAULT_CONFIG, at)).toBe(true);
  });

  it("denies outside local business hours", () => {
    const at = new Date("2026-01-11T04:00:00Z"); // Sunday 06:00 local
    expect(isWithinBusinessHours(DEFAULT_CONFIG, at)).toBe(false);
  });

  it("denies on a day not in businessDays even when the local hour is fine", () => {
    const at = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local
    expect(localParts(at, "Asia/Jerusalem").weekday).toBe("Fri");
    expect(isWithinBusinessHours(DEFAULT_CONFIG, at)).toBe(false);
  });

  it("respects an explicit UTC timezone config", () => {
    const utcConfig: BusinessHoursConfig = { ...DEFAULT_CONFIG, timezone: "UTC" };
    const at = new Date("2026-01-11T10:00:00Z"); // Sunday 10:00 UTC
    expect(isWithinBusinessHours(utcConfig, at)).toBe(true);
  });
});

describe("nextBusinessOpenTime", () => {
  it("returns the same instant when already within business hours", () => {
    const at = new Date("2026-01-11T08:00:00Z"); // Sunday 10:00 local
    expect(nextBusinessOpenTime(DEFAULT_CONFIG, at).getTime()).toBe(at.getTime());
  });

  it("defers to later the same day when called before opening", () => {
    const at = new Date("2026-01-11T04:00:00Z"); // Sunday 06:00 local
    const result = nextBusinessOpenTime(DEFAULT_CONFIG, at);
    const parts = localParts(result, "Asia/Jerusalem");
    expect(parts.weekday).toBe("Sun");
    expect(parts.hour).toBe(9);
    expect(parts.minute).toBe(0);
    expect(result.getTime()).toBeGreaterThan(at.getTime());
  });

  it("defers to the next allowed day when called after closing", () => {
    const at = new Date("2026-01-11T17:00:00Z"); // Sunday 19:00 local (after 18:00 close)
    const result = nextBusinessOpenTime(DEFAULT_CONFIG, at);
    const parts = localParts(result, "Asia/Jerusalem");
    expect(parts.weekday).toBe("Mon");
    expect(parts.hour).toBe(9);
  });

  it("skips over days that aren't in businessDays", () => {
    // Thursday after closing -> Friday/Saturday not allowed -> next is Sunday.
    const at = new Date("2026-01-15T17:00:00Z"); // Thursday 19:00 local
    const result = nextBusinessOpenTime(DEFAULT_CONFIG, at);
    const parts = localParts(result, "Asia/Jerusalem");
    expect(parts.weekday).toBe("Sun");
    expect(parts.hour).toBe(9);
  });
});

describe("endOfTodayOrNextOpen", () => {
  it("returns the end of today's business hours when called while still open", () => {
    const at = new Date("2026-01-11T08:00:00Z"); // Sunday 10:00 local
    const result = endOfTodayOrNextOpen(DEFAULT_CONFIG, at);
    const parts = localParts(result, "Asia/Jerusalem");
    expect(parts.weekday).toBe("Sun");
    expect(parts.hour).toBe(18);
    expect(parts.minute).toBe(0);
  });

  it("degrades to nextBusinessOpenTime when called before opening (no 'today' left to bound)", () => {
    const at = new Date("2026-01-11T04:00:00Z"); // Sunday 06:00 local
    expect(endOfTodayOrNextOpen(DEFAULT_CONFIG, at).getTime()).toBe(nextBusinessOpenTime(DEFAULT_CONFIG, at).getTime());
  });

  it("degrades to nextBusinessOpenTime when called after closing", () => {
    const at = new Date("2026-01-11T17:00:00Z"); // Sunday 19:00 local (after 18:00 close)
    expect(endOfTodayOrNextOpen(DEFAULT_CONFIG, at).getTime()).toBe(nextBusinessOpenTime(DEFAULT_CONFIG, at).getTime());
  });

  it("degrades to nextBusinessOpenTime on a day not in businessDays", () => {
    const at = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local, closed all day
    expect(endOfTodayOrNextOpen(DEFAULT_CONFIG, at).getTime()).toBe(nextBusinessOpenTime(DEFAULT_CONFIG, at).getTime());
  });
});
