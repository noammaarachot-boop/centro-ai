import { describe, expect, it } from "vitest";
import { describeRequirement, formatPeriodEntryLabel, renderFileFormatAnswer, renderOverviewAnswer, renderReceiptCheckAnswer, renderSupportingDocumentAnswer, type RequirementFact } from "./requestQnA";
import type { RequirementSemanticSpec } from "./ai/requirementSemantics";

// Conversational Q&A — "Centro answers only from what the office user
// actually defined." Every renderer here is pure and deterministic, so
// these are exact-match tests, not approximations of an LLM's output.

function spec(overrides: Partial<RequirementSemanticSpec>): RequirementSemanticSpec {
  return {
    originalText: "",
    documentType: "תלוש שכר",
    requiredCount: 1,
    periodType: "none",
    explicitPeriods: null,
    relativePeriod: null,
    samePeriodAllowed: false,
    distinctPeriodsRequired: false,
    distinctPeopleRequired: false,
    expectedPersonOrCompany: null,
    validityRequirement: null,
    supportingDocumentRelationship: null,
    freeTextConstraints: null,
    interpretationConfidence: 0.95,
    clarifyingQuestion: null,
    ...overrides,
  };
}

describe("formatPeriodEntryLabel", () => {
  it("converts a concrete MM/YYYY into a Hebrew month name", () => {
    expect(formatPeriodEntryLabel("06/2026")).toBe("יוני");
  });
  it("converts a bare MM into a Hebrew month name", () => {
    expect(formatPeriodEntryLabel("01")).toBe("ינואר");
  });
  it("leaves a malformed entry untouched rather than guessing", () => {
    expect(formatPeriodEntryLabel("XX")).toBe("XX");
  });
});

describe("describeRequirement", () => {
  it("no spec: falls back to the requirement's own stored name verbatim", () => {
    expect(describeRequirement("3 תלושי שכר של יוני", 3, null)).toBe("3 תלושי שכר של יוני");
  });

  it("'3 תלושי שכר של שלושת החודשים האחרונים' -> relative distinct-months phrasing", () => {
    const s = spec({
      requiredCount: 3,
      periodType: "relative",
      relativePeriod: { kind: "last_n_months", n: 3 },
      distinctPeriodsRequired: true,
      samePeriodAllowed: false,
    });
    expect(describeRequirement("3 תלושי שכר של שלושת החודשים האחרונים", 3, s)).toBe(
      "3 תלושי שכר, אחד מכל אחד מ-3 החודשים האחרונים"
    );
  });

  it("'3 תלושי שכר של חודש יוני' -> explicit same-month phrasing", () => {
    const s = spec({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06/2026"],
      samePeriodAllowed: true,
      distinctPeriodsRequired: false,
    });
    expect(describeRequirement("3 תלושי שכר של חודש יוני", 3, s)).toBe("3 תלושי שכר של חודש יוני");
  });

  it("explicit distinct months (ינואר/פברואר/מרץ) lists every month", () => {
    const s = spec({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["01/2026", "02/2026", "03/2026"],
      samePeriodAllowed: false,
      distinctPeriodsRequired: true,
    });
    expect(describeRequirement("תלושי שכר ינואר פברואר מרץ", 3, s)).toBe(
      "3 תלושי שכר, אחד מכל אחד מהחודשים: ינואר, פברואר, מרץ"
    );
  });

  it("distinct people required appends a Hebrew note", () => {
    const s = spec({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06/2026"],
      samePeriodAllowed: true,
      distinctPeopleRequired: true,
    });
    expect(describeRequirement("3 תלושי שכר ליוני, לעובדים שונים", 3, s)).toBe(
      "3 תלושי שכר של חודש יוני, לאנשים שונים"
    );
  });

  it("no count/period at all (e.g. תעודת זהות) just returns the clean document type", () => {
    const s = spec({ documentType: "תעודת זהות", requiredCount: 1 });
    expect(describeRequirement("תעודת זהות", 1, s)).toBe("תעודת זהות");
  });

  it("a document type outside the plural map degrades gracefully (still readable)", () => {
    const s = spec({ documentType: "אישור לימודים", requiredCount: 2 });
    expect(describeRequirement("2 אישורי לימודים", 2, s)).toBe("2 אישור לימודים");
  });
});

function fact(overrides: Partial<RequirementFact>): RequirementFact {
  return {
    id: "r1",
    description: "תעודת זהות",
    requiredCount: 1,
    satisfiedCount: 0,
    satisfied: false,
    supportingDocumentRelationship: null,
    ...overrides,
  };
}

describe("renderOverviewAnswer", () => {
  it("lists every requirement with its real status, never inventing one not stored", () => {
    const text = renderOverviewAnswer([
      fact({ id: "r1", description: "תעודת זהות", satisfied: true, satisfiedCount: 1, requiredCount: 1 }),
      fact({ id: "r2", description: "3 תלושי שכר של חודש יוני", requiredCount: 3, satisfiedCount: 1, satisfied: false }),
      fact({ id: "r3", description: "אישור שכירות", requiredCount: 1, satisfiedCount: 0, satisfied: false }),
    ]);
    expect(text).toContain("תעודת זהות — התקבל");
    expect(text).toContain("3 תלושי שכר של חודש יוני — התקבלו 1 מתוך 3");
    expect(text).toContain("אישור שכירות — טרם התקבל");
  });

  it("an empty requirement list never invents a document", () => {
    expect(renderOverviewAnswer([])).not.toContain("תלוש");
  });
});

describe("renderReceiptCheckAnswer", () => {
  it("reports nothing received yet, honestly, when there's no document at all", () => {
    expect(renderReceiptCheckAnswer(null)).toContain("לא התקבל");
  });
  it("names the real status and requirement of the most recent document", () => {
    const text = renderReceiptCheckAnswer({ status: "approved", requirementDescription: "תעודת זהות" });
    expect(text).toContain("התקבל ואושר");
    expect(text).toContain("תעודת זהות");
  });
});

describe("renderSupportingDocumentAnswer", () => {
  it("says plainly that nothing was specified when no requirement mentions a supporting document", () => {
    expect(renderSupportingDocumentAnswer([fact({})])).toContain("לא צוינה דרישה");
  });
  it("surfaces exactly the office user's own stated supporting-document relationship", () => {
    const text = renderSupportingDocumentAnswer([
      fact({ description: "תעודת זהות", supportingDocumentRelationship: "כולל ספח עדכני" }),
    ]);
    expect(text).toContain("כולל ספח עדכני");
  });
});

describe("renderFileFormatAnswer", () => {
  it("lists the real supported formats, not a guess", () => {
    const text = renderFileFormatAnswer();
    expect(text).toContain("PDF");
    expect(text).toContain("JPG");
  });
});
