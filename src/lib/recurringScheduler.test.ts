import { describe, expect, it } from "vitest";
import {
  advanceCollectionRunAt,
  computeInitialCollectionRunAt,
  formatAutoPeriodLabel,
} from "./recurringScheduler";

describe("computeInitialCollectionRunAt", () => {
  it("uses this month's anchor day when it hasn't passed yet", () => {
    const from = new Date(2026, 0, 5); // Jan 5, 2026
    const result = computeInitialCollectionRunAt(15, from);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(15);
  });

  it("rolls over to next month once the anchor day has already passed", () => {
    const from = new Date(2026, 0, 20); // Jan 20, 2026
    const result = computeInitialCollectionRunAt(15, from);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it("clamps an anchor day beyond a short month's length", () => {
    // From late January, anchor day 31 rolls to February, which only has 28
    // days in 2026 (not a leap year).
    const from = new Date(2026, 0, 31, 23, 59);
    const result = computeInitialCollectionRunAt(31, from);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });
});

describe("advanceCollectionRunAt", () => {
  it("advances from the previous scheduled date, not from now, avoiding drift", () => {
    const previous = new Date(2026, 0, 15); // Jan 15
    const result = advanceCollectionRunAt(previous, 15, 1);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it("supports a custom multi-month interval (e.g. quarterly)", () => {
    const previous = new Date(2026, 0, 10);
    const result = advanceCollectionRunAt(previous, 10, 3);
    expect(result.getMonth()).toBe(3); // April — three months after January
    expect(result.getDate()).toBe(10);
  });

  it("clamps into a shorter month when advancing past a 31-day anchor", () => {
    const previous = new Date(2026, 0, 31); // Jan 31
    const result = advanceCollectionRunAt(previous, 31, 1);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(28); // 2026 is not a leap year
  });

  it("rolls over the year boundary correctly", () => {
    const previous = new Date(2026, 11, 5); // Dec 5, 2026
    const result = advanceCollectionRunAt(previous, 5, 1);
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
  });
});

describe("formatAutoPeriodLabel", () => {
  it("labels a monthly cycle with just the month and year", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 0, 15), 1)).toBe("ינואר 2026");
  });

  it("labels a quarterly cycle as a month range within the same year", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 2, 15), 3)).toBe("ינואר–מרץ 2026");
  });

  it("labels a range spanning a year boundary with both years", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 1, 1), 6)).toBe("ספטמבר 2025–פברואר 2026");
  });
});
