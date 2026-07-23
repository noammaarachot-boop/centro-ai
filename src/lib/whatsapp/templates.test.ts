import { describe, expect, it } from "vitest";
import { LEAD_WELCOME_TEMPLATE, REQUIRED_TEMPLATES, TEMPLATE_BY_BODY } from "./templates";

describe("TEMPLATE_BY_BODY", () => {
  it("has one entry per required template, keyed by its exact body text", () => {
    expect(TEMPLATE_BY_BODY.size).toBe(REQUIRED_TEMPLATES.length);
    for (const template of REQUIRED_TEMPLATES) {
      expect(TEMPLATE_BY_BODY.get(template.bodyText)).toBe(template);
    }
  });
});

describe("template definitions", () => {
  it("every template name is unique", () => {
    const allTemplates = [...REQUIRED_TEMPLATES, LEAD_WELCOME_TEMPLATE];
    const names = allTemplates.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Regression test for the live INVALID_FORMAT rejection found while
  // building M-WA-5: Meta rejects submission outright for any template
  // whose body contains a {{n}} placeholder without a matching
  // exampleParams entry.
  it("every template with a {{n}} placeholder declares exampleParams", () => {
    const allTemplates = [...REQUIRED_TEMPLATES, LEAD_WELCOME_TEMPLATE];
    for (const template of allTemplates) {
      const placeholderCount = (template.bodyText.match(/\{\{\d+\}\}/g) ?? []).length;
      if (placeholderCount > 0) {
        expect(template.exampleParams?.length ?? 0).toBeGreaterThanOrEqual(placeholderCount);
      }
    }
  });

  it("none of the four per-org templates use a placeholder (none need exampleParams)", () => {
    for (const template of REQUIRED_TEMPLATES) {
      expect(template.bodyText).not.toMatch(/\{\{\d+\}\}/);
      expect(template.exampleParams).toBeUndefined();
    }
  });
});
