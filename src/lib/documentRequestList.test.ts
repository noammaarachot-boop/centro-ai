import { describe, expect, it } from "vitest";
import { formatRequirementListForTemplateParam } from "./documentRequestList";

describe("formatRequirementListForTemplateParam", () => {
  it("builds a single-line, comma-separated list from the given requirement names", () => {
    const names = ["תעודת זהות", "דפי חשבון בנק", "דו״ח תיק השקעות"];
    const param = formatRequirementListForTemplateParam(names);
    expect(param).toBe("תעודת זהות, דפי חשבון בנק, דו״ח תיק השקעות");
  });

  it("reflects whatever the caller supplies — a different user's list yields a different string (no hardcoding)", () => {
    const names = ["רישיון עסק", "חוזה שכירות", "אישור ניהול ספרים"];
    const param = formatRequirementListForTemplateParam(names);
    expect(param).toBe("רישיון עסק, חוזה שכירות, אישור ניהול ספרים");
  });

  it("contains no newlines, tabs, or runs of >4 spaces (Meta template-parameter constraints)", () => {
    const param = formatRequirementListForTemplateParam(["מסמך א", "מסמך ב", "מסמך ג"]);
    expect(param).not.toMatch(/[\n\t]/);
    expect(param).not.toMatch(/ {5,}/);
  });

  it("handles a single-item list without a trailing separator", () => {
    expect(formatRequirementListForTemplateParam(["תעודת זהות"])).toBe("תעודת זהות");
  });

  it("produces an empty string for an empty list (callers must block sends before reaching here)", () => {
    expect(formatRequirementListForTemplateParam([])).toBe("");
  });
});
