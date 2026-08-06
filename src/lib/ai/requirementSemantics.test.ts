import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { parseRequirementSemantics, requiresClarification, resolveExplicitPeriodsForSnapshot, MIN_CONFIDENCE_TO_AUTO_SAVE } =
  await import("./requirementSemantics");

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

function mockObject(overrides: Record<string, unknown>) {
  generateObject.mockResolvedValueOnce({
    object: {
      documentType: "תלוש שכר",
      requiredCount: 1,
      periodType: "none",
      explicitPeriods: null,
      relativeMonths: null,
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
    },
  });
}

describe("parseRequirementSemantics", () => {
  it("'3 תלושי שכר של 3 החודשים האחרונים' -> relative period, distinct months required", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({
      requiredCount: 3,
      periodType: "relative",
      relativeMonths: 3,
      distinctPeriodsRequired: true,
      samePeriodAllowed: false,
      interpretationConfidence: 0.9,
    });

    const spec = await parseRequirementSemantics("3 תלושי שכר של 3 החודשים האחרונים");
    expect(spec.requiredCount).toBe(3);
    expect(spec.periodType).toBe("relative");
    expect(spec.relativePeriod).toEqual({ kind: "last_n_months", n: 3 });
    expect(spec.distinctPeriodsRequired).toBe(true);
    expect(spec.samePeriodAllowed).toBe(false);
    expect(requiresClarification(spec)).toBe(false);
  });

  it("'3 תלושי שכר של חודש יוני' -> explicit single period, same period allowed", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06"],
      samePeriodAllowed: true,
      distinctPeriodsRequired: false,
      interpretationConfidence: 0.92,
    });

    const spec = await parseRequirementSemantics("3 תלושי שכר של חודש יוני");
    expect(spec.explicitPeriods).toEqual(["06"]);
    expect(spec.samePeriodAllowed).toBe(true);
    expect(spec.distinctPeriodsRequired).toBe(false);
  });

  it("'תלושי שכר של ינואר, פברואר ומרץ' -> explicit distinct periods", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["01", "02", "03"],
      distinctPeriodsRequired: true,
      samePeriodAllowed: false,
      interpretationConfidence: 0.93,
    });

    const spec = await parseRequirementSemantics("תלושי שכר של ינואר, פברואר ומרץ");
    expect(spec.explicitPeriods).toEqual(["01", "02", "03"]);
    expect(spec.distinctPeriodsRequired).toBe(true);
  });

  it("'3 תלושי שכר לעובדים שונים לחודש יוני' -> distinct people required", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06"],
      samePeriodAllowed: true,
      distinctPeopleRequired: true,
      interpretationConfidence: 0.88,
    });

    const spec = await parseRequirementSemantics("3 תלושי שכר לעובדים שונים לחודש יוני");
    expect(spec.distinctPeopleRequired).toBe(true);
    expect(spec.requiredCount).toBe(3);
  });

  it("'תלוש השכר האחרון' -> requiredCount 1, no distinctness question at all", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({ requiredCount: 1, periodType: "relative", relativeMonths: 1, interpretationConfidence: 0.9 });

    const spec = await parseRequirementSemantics("תלוש השכר האחרון");
    expect(spec.requiredCount).toBe(1);
  });

  it("an ambiguous bare count never invents a rule — low confidence, carries a clarifying question", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    mockObject({
      requiredCount: 3,
      periodType: "unspecified",
      interpretationConfidence: 0.4,
      clarifyingQuestion: "רק כדי לוודא: כשכתבת '3 תלושי שכר', התכוונת לשלושה חודשים שונים או לשלושה תלושים מאותו חודש?",
    });

    const spec = await parseRequirementSemantics("3 תלושי שכר");
    expect(requiresClarification(spec)).toBe(true);
    expect(spec.clarifyingQuestion).toContain("שלושה חודשים שונים");
    // Never silently defaults distinctPeriodsRequired/samePeriodAllowed to
    // a guessed true — both stay whatever the (low-confidence) parse said,
    // and the caller must not act on it without clarification.
  });

  it("never guesses on a provider failure — returns a low-confidence spec requiring clarification", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const spec = await parseRequirementSemantics("3 תלושי שכר");
    expect(requiresClarification(spec)).toBe(true);
    expect(spec.interpretationConfidence).toBe(0);
  });

  it("MIN_CONFIDENCE_TO_AUTO_SAVE is the exact boundary requiresClarification uses", () => {
    expect(requiresClarification({ interpretationConfidence: MIN_CONFIDENCE_TO_AUTO_SAVE } as never)).toBe(false);
    expect(requiresClarification({ interpretationConfidence: MIN_CONFIDENCE_TO_AUTO_SAVE - 0.01 } as never)).toBe(true);
  });
});

describe("resolveExplicitPeriodsForSnapshot", () => {
  it("returns null when there are no explicit periods", () => {
    expect(resolveExplicitPeriodsForSnapshot(null, new Date("2026-08-06"))).toBeNull();
  });

  it("resolves a month-only entry to this year when the month hasn't passed yet relative to the anchor", () => {
    // Anchor: August 2026. Requested month: December (12) -> hasn't
    // happened yet this year relative to August, so it must mean last
    // December (the most recently completed one), not a future one.
    const result = resolveExplicitPeriodsForSnapshot(["12"], new Date("2026-08-06"));
    expect(result).toEqual(["12/2025"]);
  });

  it("resolves a month-only entry to this year when the month has already passed this year", () => {
    // Anchor: August 2026. Requested month: June (06) -> already happened
    // this year, so this year's June.
    const result = resolveExplicitPeriodsForSnapshot(["06"], new Date("2026-08-06"));
    expect(result).toEqual(["06/2026"]);
  });

  it("leaves an already-concrete MM/YYYY entry untouched", () => {
    const result = resolveExplicitPeriodsForSnapshot(["03/2025"], new Date("2026-08-06"));
    expect(result).toEqual(["03/2025"]);
  });

  it("resolves multiple entries independently", () => {
    const result = resolveExplicitPeriodsForSnapshot(["01", "02", "03"], new Date("2026-08-06"));
    expect(result).toEqual(["01/2026", "02/2026", "03/2026"]);
  });
});
