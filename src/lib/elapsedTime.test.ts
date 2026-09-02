import { describe, expect, it } from "vitest";
import {
  daysSince,
  describeElapsed,
  describeEscalation,
  formatDayCount,
  stripFrozenDayCount,
} from "./elapsedTime";

/**
 * Regression — the same screen showed two different ages.
 *
 * The attention panel said "עברו 7 ימים" (measured from createdAt) while the
 * summary line above it said "לא ענה — חלפו 3 ימים והבקשה עדיין לא הושלמה"
 * (a string frozen into escalationReason at escalation time). The 3 was the
 * THRESHOLD, not elapsed time, and it never moved again.
 */

const NOW = new Date("2026-08-26T12:00:00Z").getTime();
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000);

describe("daysSince", () => {
  const TZ = "Asia/Jerusalem";

  it("counts CALENDAR days, not 24-hour blocks", () => {
    // 23.8 10:36 Israel -> 27.8 09:09 Israel is 3.94 * 24h, but four dates
    // have turned over. Math.floor(ms / 24h) said 3 and is the whole bug.
    expect(daysSince("2026-08-23T07:36:55Z", TZ, Date.parse("2026-08-27T06:09:32Z"))).toBe(4);
  });

  it("counts whole elapsed days", () => {
    expect(daysSince(daysAgo(7), TZ, NOW)).toBe(7);
    expect(daysSince(daysAgo(0), TZ, NOW)).toBe(0);
  });

  it("never returns a negative age for a future timestamp", () => {
    expect(daysSince(new Date(NOW + 5 * 86400000), TZ, NOW)).toBe(0);
  });

  it("accepts the string form a serialized row arrives as", () => {
    expect(daysSince(daysAgo(3).toISOString(), TZ, NOW)).toBe(3);
  });

  it("does not throw on an unparseable value", () => {
    expect(daysSince("not a date", TZ, NOW)).toBe(0);
  });

  it("uses the organization's zone, not the render process's", () => {
    // 22:30Z on the 26th is already the 27th in Israel: one date has turned
    // over there, none in UTC. Vercel renders in UTC.
    const opened = "2026-08-26T22:30:00Z";
    const later = Date.parse("2026-08-27T05:00:00Z");
    expect(daysSince(opened, TZ, later)).toBe(0);
    expect(daysSince(opened, "UTC", later)).toBe(1);
  });

  it("advances by one each day WITHOUT anything being rewritten", () => {
    const opened = "2026-08-23T07:36:55Z";
    const ages = [
      daysSince(opened, TZ, Date.parse("2026-08-26T13:00:00Z")),
      daysSince(opened, TZ, Date.parse("2026-08-27T06:09:00Z")),
      daysSince(opened, TZ, Date.parse("2026-08-28T06:09:00Z")),
    ];
    expect(ages, "the number must climb on its own").toEqual([3, 4, 5]);
  });
});

describe("formatDayCount", () => {
  it("uses Hebrew's dual form rather than '2 ימים'", () => {
    expect(formatDayCount(1)).toBe("יום אחד");
    expect(formatDayCount(2)).toBe("יומיים");
    expect(formatDayCount(3)).toBe("3 ימים");
  });
});

describe("stripFrozenDayCount", () => {
  it("removes the exact clause stored in production", () => {
    expect(stripFrozenDayCount("לא ענה — חלפו 3 ימים והבקשה עדיין לא הושלמה")).toBe(
      "לא ענה והבקשה עדיין לא הושלמה"
    );
  });

  it("leaves a reason that carries no day count untouched", () => {
    expect(stripFrozenDayCount("הלקוח ביקש לדבר עם נציג")).toBe("הלקוח ביקש לדבר עם נציג");
  });

  it("never leaves a dangling separator at either end", () => {
    expect(stripFrozenDayCount("חלפו 3 ימים")).toBe("");
    expect(stripFrozenDayCount("לא ענה — חלפו 12 ימים")).toBe("לא ענה");
  });
});

describe("describeEscalation", () => {
  it("reports the REAL age, not the threshold frozen into the row", () => {
    const line = describeEscalation("לא ענה — חלפו 3 ימים והבקשה עדיין לא הושלמה", 7);

    expect(line, "the stale 3 must be gone").not.toContain("3 ימים");
    expect(line).toContain("7 ימים");
  });

  it("falls back to a plain sentence when nothing was stored", () => {
    expect(describeEscalation(null, 4)).toBe("הבקשה הוסלמה לבדיקה ידנית — עברו 4 ימים");
  });

  it("does not claim days have passed on the day it was opened", () => {
    expect(describeEscalation("לא ענה", 0)).toContain("היום");
  });
});

describe("the threshold does not live here any more", () => {
  it("is never what the user is told has elapsed", () => {
    // This file used to export its own OVERDUE_AFTER_DAYS = 3 while the
    // scheduler held a second copy. The threshold is now the organization's
    // own setting (organizations.humanReviewAfterDays, resolved in
    // src/lib/attention/policy.ts), and a module-level constant here would be
    // a value with no tenant attached — exactly what had to stop existing.
    //
    // What this file still owns is how long something has actually been, for
    // a person to read, which is a different number from any threshold.
    expect(describeElapsed(7)).toBe("עברו 7 ימים");
    expect(describeElapsed(3)).toBe("עברו 3 ימים");
  });
});
