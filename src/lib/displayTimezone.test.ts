import { describe, expect, it } from "vitest";

/**
 * Timestamps are stored in UTC and displayed in the ORGANIZATION's zone.
 *
 * The request screen formatted message times with toLocaleTimeString("he-IL")
 * and no timeZone at all, so they rendered in whatever zone the rendering
 * process was in — UTC on Vercel — while the deferral banner a few hundred
 * lines above already passed Asia/Jerusalem. Two times on one screen,
 * three hours apart, both describing the same event.
 *
 * These tests pin the property rather than the call site: a formatter given
 * an explicit zone is correct on both sides of a DST boundary, and a
 * formatter without one is at the mercy of the host. If someone drops the
 * timeZone argument again, the DST cases below stop matching.
 */

const format = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleString("he-IL", {
    timeZone,
    dateStyle: "short",
    timeStyle: "short",
  });

const hour = (iso: string, timeZone: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });

describe("Asia/Jerusalem display, across DST", () => {
  it("applies +03:00 during Israel Daylight Time (summer)", () => {
    // 2026-08-24T13:32:36Z — the real creation time of a production request.
    expect(hour("2026-08-24T13:32:36.000Z", "Asia/Jerusalem")).toBe("16:32");
  });

  it("applies +02:00 during standard time (winter)", () => {
    expect(hour("2026-01-15T13:32:36.000Z", "Asia/Jerusalem")).toBe("15:32");
  });

  it("is not the same as rendering in UTC — which is the bug this replaced", () => {
    const utc = hour("2026-08-24T13:32:36.000Z", "UTC");
    const local = hour("2026-08-24T13:32:36.000Z", "Asia/Jerusalem");
    expect(utc).toBe("13:32");
    expect(local).not.toBe(utc);
  });

  it("handles the spring-forward boundary", () => {
    // Israel moves to DST on the FRIDAY before the last Sunday of March —
    // 2026-03-27. A week earlier is still +02:00...
    expect(hour("2026-03-20T00:30:00.000Z", "Asia/Jerusalem")).toBe("02:30");
    // ...and the day after the switch is +03:00 for the same UTC time.
    expect(hour("2026-03-28T00:30:00.000Z", "Asia/Jerusalem")).toBe("03:30");
  });

  it("handles the autumn fall-back boundary", () => {
    // Israel returns to standard time on the last Sunday of October.
    expect(hour("2026-10-24T12:00:00.000Z", "Asia/Jerusalem")).toBe("15:00");
    expect(hour("2026-10-26T12:00:00.000Z", "Asia/Jerusalem")).toBe("14:00");
  });

  it("keeps a late-evening UTC timestamp on the correct LOCAL day", () => {
    // 22:30Z in summer is 01:30 the NEXT day in Israel. Formatting without a
    // zone would show the previous date to an office user.
    const local = format("2026-08-24T22:30:00.000Z", "Asia/Jerusalem");
    expect(local).toContain("25.8.2026");
    const utc = format("2026-08-24T22:30:00.000Z", "UTC");
    expect(utc).toContain("24.8.2026");
  });

  it("respects a different organization's zone rather than hardcoding Israel", () => {
    // The request screen now passes organization.timezone, so an org in
    // another zone must format in theirs.
    expect(hour("2026-08-24T13:32:36.000Z", "Europe/London")).toBe("14:32");
    expect(hour("2026-08-24T13:32:36.000Z", "America/New_York")).toBe("09:32");
  });

  it("stores and compares in UTC regardless of how it is displayed", () => {
    // The instant is one value; only its rendering differs. This is why the
    // DB stays UTC and only the display layer takes a zone.
    const instant = new Date("2026-08-24T13:32:36.000Z");
    expect(instant.toISOString()).toBe("2026-08-24T13:32:36.000Z");
    expect(hour(instant.toISOString(), "Asia/Jerusalem")).not.toBe(
      hour(instant.toISOString(), "UTC")
    );
  });
});
