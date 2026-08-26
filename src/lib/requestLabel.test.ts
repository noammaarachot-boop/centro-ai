import { describe, expect, it } from "vitest";
import { buildPeriodLabel, describeRequestLine, formatLabelDate } from "./requestLabel";

/**
 * Regression — the dashboard said the same thing twice.
 *
 * "בקשות בתהליך" renders `serviceName · periodLabel`, and the period label
 * is DERIVED from the service name, so the row repeated it. Production also
 * holds "בקשת מסמכים — 24.8.2026 — 24.8.2026", because the label was built
 * as `${template.name} — ${today}` with no check that the name already
 * ended in a date.
 */

const TZ = "Asia/Jerusalem";

describe("buildPeriodLabel", () => {
  it("appends today's date to a plain template name", () => {
    const label = buildPeriodLabel("בקשת מסמכים", new Date("2026-08-24T09:00:00Z"), TZ);
    expect(label).toBe("בקשת מסמכים — 24.8.2026");
  });

  it("does not append a date the name already carries", () => {
    const label = buildPeriodLabel("בקשת מסמכים — 24.8.2026", new Date("2026-08-24T09:00:00Z"), TZ);
    expect(label, "this is the production string, and it must not double").toBe("בקשת מסמכים — 24.8.2026");
  });

  it("does not stack a second date onto a name ending in an OLDER date", () => {
    const label = buildPeriodLabel("מסמכים להחזרי מס — 23.8.2026", new Date("2026-08-24T09:00:00Z"), TZ);
    expect(label).toBe("מסמכים להחזרי מס — 23.8.2026");
  });

  it("formats the date in the organization's zone, not the server's", () => {
    // 22:30Z on the 24th is already the 25th in Israel.
    const late = new Date("2026-08-24T22:30:00Z");
    expect(formatLabelDate(late, TZ)).toBe("25.8.2026");
    expect(formatLabelDate(late, "UTC")).toBe("24.8.2026");
    expect(buildPeriodLabel("בקשה", late, TZ)).toBe("בקשה — 25.8.2026");
  });

  it("trims stray whitespace rather than baking it into the label", () => {
    expect(buildPeriodLabel("  בקשת מסמכים  ", new Date("2026-08-24T09:00:00Z"), TZ)).toBe("בקשת מסמכים — 24.8.2026");
  });
});

describe("describeRequestLine", () => {
  it("says it once when the period label already starts with the service name", () => {
    expect(describeRequestLine("בקשת מסמכים", "בקשת מסמכים — 24.8.2026")).toBe("בקשת מסמכים — 24.8.2026");
  });

  it("collapses the exact production duplicate", () => {
    // What the dashboard actually rendered.
    const line = describeRequestLine("בקשת מסמכים — 24.8.2026", "בקשת מסמכים — 24.8.2026 — 24.8.2026");
    expect(line).toBe("בקשת מסמכים — 24.8.2026 — 24.8.2026");
    expect(line.startsWith("בקשת מסמכים — 24.8.2026 · ")).toBe(false);
  });

  it("keeps both when they are genuinely different information", () => {
    expect(describeRequestLine("דוח שנתי", "2026-Q1")).toBe("דוח שנתי · 2026-Q1");
  });

  it("handles identical values without repeating them", () => {
    expect(describeRequestLine("בקשת מסמכים", "בקשת מסמכים")).toBe("בקשת מסמכים");
  });

  it("survives an empty side rather than printing a bare separator", () => {
    expect(describeRequestLine("בקשת מסמכים", "")).toBe("בקשת מסמכים");
    expect(describeRequestLine("", "2026-Q1")).toBe("2026-Q1");
  });
});
