import { describe, expect, it } from "vitest";
import {
  OVERDUE_AFTER_DAYS,
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
  it("counts whole elapsed days", () => {
    expect(daysSince(daysAgo(7), NOW)).toBe(7);
    expect(daysSince(daysAgo(0), NOW)).toBe(0);
  });

  it("never returns a negative age for a future timestamp", () => {
    expect(daysSince(new Date(NOW + 5 * 86400000), NOW)).toBe(0);
  });

  it("accepts the string form a serialized row arrives as", () => {
    expect(daysSince(daysAgo(3).toISOString(), NOW)).toBe(3);
  });

  it("does not throw on an unparseable value", () => {
    expect(daysSince("not a date", NOW)).toBe(0);
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

describe("the threshold is not a duration", () => {
  it("stays available as internal logic", () => {
    expect(OVERDUE_AFTER_DAYS).toBe(3);
  });

  it("is never what the user is told has elapsed", () => {
    // A request escalated at the threshold but read four days later.
    expect(describeElapsed(7)).toBe("עברו 7 ימים");
    expect(describeElapsed(OVERDUE_AFTER_DAYS)).toBe("עברו 3 ימים");
  });
});
