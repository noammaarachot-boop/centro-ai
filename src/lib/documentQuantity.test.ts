import { describe, expect, it } from "vitest";
import { computeRequirementSatisfaction, extractedPeriodLabelForStorage } from "./documentQuantity";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

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
    interpretationConfidence: 0.9,
    clarifyingQuestion: null,
    ...overrides,
  };
}

describe("computeRequirementSatisfaction — 'I don't have this document' exception (exceptionStatus)", () => {
  it("a requirement the employee waived counts as fully satisfied regardless of documents", () => {
    expect(
      computeRequirementSatisfaction({ requiredCount: 3, semanticSpec: null, exceptionStatus: "waived" }, [])
    ).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("any other exception status (reported_missing, will_contact_client, left_open) has no effect on satisfaction", () => {
    for (const exceptionStatus of ["reported_missing", "will_contact_client", "left_open"]) {
      expect(
        computeRequirementSatisfaction({ requiredCount: 1, semanticSpec: null, exceptionStatus }, [])
      ).toEqual({ satisfiedCount: 0, satisfied: false });
    }
  });
});

describe("computeRequirementSatisfaction — legacy fallback (no semanticSpec)", () => {
  it("a single document (requiredCount 1) satisfies exactly like before this feature existed", () => {
    expect(computeRequirementSatisfaction({ requiredCount: 1, semanticSpec: null }, [{ periodLabel: null, personName: null }])).toEqual({
      satisfiedCount: 1,
      satisfied: true,
    });
    expect(computeRequirementSatisfaction({ requiredCount: 1, semanticSpec: null }, [])).toEqual({ satisfiedCount: 0, satisfied: false });
  });

  it("counts distinct period labels toward requiredCount", () => {
    const docs = ["01/2026", "02/2026", "03/2026"].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction({ requiredCount: 3, semanticSpec: null }, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("two documents sharing the same period count as one unit, not two", () => {
    const docs = ["01/2026", "01/2026", "02/2026"].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction({ requiredCount: 3, semanticSpec: null }, docs)).toEqual({ satisfiedCount: 2, satisfied: false });
  });

  it("treats an undated document (null label) as its own distinct unit — never blocks on an extraction gap", () => {
    const docs = [null, null, null].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction({ requiredCount: 3, semanticSpec: null }, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });
});

// Mandatory scenarios #1-5 from the semantic-requirement-engine spec.
describe("computeRequirementSatisfaction — semantic spec drives satisfaction", () => {
  it("scenario 1: '3 payslips, 3 last months' + 3 payslips for the SAME month -> NOT satisfied", () => {
    const requirement = { requiredCount: 3, semanticSpec: spec({ periodType: "relative", relativePeriod: { kind: "last_n_months", n: 3 }, distinctPeriodsRequired: true }) };
    const docs = ["06/2026", "06/2026", "06/2026"].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 1, satisfied: false });
  });

  it("scenario 2: same requirement + 3 DIFFERENT months -> satisfied", () => {
    const requirement = { requiredCount: 3, semanticSpec: spec({ periodType: "relative", relativePeriod: { kind: "last_n_months", n: 3 }, distinctPeriodsRequired: true }) };
    const docs = ["04/2026", "05/2026", "06/2026"].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("scenario 3: '3 payslips of June' + 3 payslips all for June -> satisfied (duplicates of the same period are expected)", () => {
    const requirement = { requiredCount: 3, semanticSpec: spec({ periodType: "explicit", explicitPeriods: ["06/2026"], samePeriodAllowed: true }) };
    const docs = ["06/2026", "06/2026", "06/2026"].map((periodLabel) => ({ periodLabel, personName: null }));
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("scenario 3b: '3 payslips of June' — a payslip from a different month never counts toward it", () => {
    const requirement = { requiredCount: 3, semanticSpec: spec({ periodType: "explicit", explicitPeriods: ["06/2026"], samePeriodAllowed: true }) };
    const docs = [
      { periodLabel: "06/2026", personName: null },
      { periodLabel: "06/2026", personName: null },
      { periodLabel: "07/2026", personName: null }, // wrong month — silently doesn't count, never an anomaly
    ];
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 2, satisfied: false });
  });

  it("scenario 4: '3 payslips, different employees, June' + the SAME employee 3 times -> NOT satisfied", () => {
    const requirement = {
      requiredCount: 3,
      semanticSpec: spec({ periodType: "explicit", explicitPeriods: ["06/2026"], samePeriodAllowed: true, distinctPeopleRequired: true }),
    };
    const docs = ["06/2026", "06/2026", "06/2026"].map((periodLabel) => ({ periodLabel, personName: "נועם שלום" }));
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 1, satisfied: false });
  });

  it("scenario 5: same requirement + 3 DIFFERENT employees -> satisfied", () => {
    const requirement = {
      requiredCount: 3,
      semanticSpec: spec({ periodType: "explicit", explicitPeriods: ["06/2026"], samePeriodAllowed: true, distinctPeopleRequired: true }),
    };
    const docs = [
      { periodLabel: "06/2026", personName: "נועם שלום" },
      { periodLabel: "06/2026", personName: "ישראל ישראלי" },
      { periodLabel: "06/2026", personName: "אורית לוי" },
    ];
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("distinct-people fuzzy-matches names the same way identity-anomaly detection does (OCR noise, reversed order)", () => {
    const requirement = { requiredCount: 2, semanticSpec: spec({ distinctPeopleRequired: true }) };
    const docs = [
      { periodLabel: null, personName: "נועם שלום" },
      { periodLabel: null, personName: "שלום נועם" }, // reversed order — same person
    ];
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 1, satisfied: false });
  });

  it("a single explicit-period document (requiredCount 1, 'the last payslip') is trivially satisfied", () => {
    const requirement = { requiredCount: 1, semanticSpec: spec({ periodType: "relative", relativePeriod: { kind: "last_n_months", n: 1 } }) };
    expect(computeRequirementSatisfaction(requirement, [{ periodLabel: "07/2026", personName: null }])).toEqual({
      satisfiedCount: 1,
      satisfied: true,
    });
  });

  it("an undated document is still counted permissively even under an explicit-period filter — never blocks on an extraction gap", () => {
    const requirement = { requiredCount: 3, semanticSpec: spec({ periodType: "explicit", explicitPeriods: ["06/2026"], samePeriodAllowed: true }) };
    const docs = [
      { periodLabel: "06/2026", personName: null },
      { periodLabel: null, personName: null },
      { periodLabel: null, personName: null },
    ];
    expect(computeRequirementSatisfaction(requirement, docs)).toEqual({ satisfiedCount: 3, satisfied: true });
  });
});

describe("extractedPeriodLabelForStorage", () => {
  it("returns null when the AI never ran", () => {
    expect(extractedPeriodLabelForStorage({ aiRan: false, extractedPeriodLabel: "01/2026", periodExtractionConfidence: 0.9 })).toBeNull();
  });

  it("returns null below the confidence floor — never persists a guess", () => {
    expect(extractedPeriodLabelForStorage({ aiRan: true, extractedPeriodLabel: "01/2026", periodExtractionConfidence: 0.2 })).toBeNull();
  });

  it("returns the label once confidence clears the floor", () => {
    expect(extractedPeriodLabelForStorage({ aiRan: true, extractedPeriodLabel: "01/2026", periodExtractionConfidence: 0.8 })).toBe("01/2026");
  });
});
