import { describe, expect, it } from "vitest";
import { computeRequirementSatisfaction, extractedPeriodLabelForStorage } from "./documentQuantity";

describe("computeRequirementSatisfaction", () => {
  it("a single document (requiredCount 1) satisfies exactly like before this feature existed", () => {
    expect(computeRequirementSatisfaction(1, [null])).toEqual({ satisfiedCount: 1, satisfied: true });
    expect(computeRequirementSatisfaction(1, [])).toEqual({ satisfiedCount: 0, satisfied: false });
  });

  it("counts distinct period labels toward requiredCount", () => {
    const result = computeRequirementSatisfaction(3, ["01/2026", "02/2026", "03/2026"]);
    expect(result).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("two documents sharing the same period count as one unit, not two", () => {
    const result = computeRequirementSatisfaction(3, ["01/2026", "01/2026", "02/2026"]);
    expect(result).toEqual({ satisfiedCount: 2, satisfied: false });
  });

  it("three documents for the exact same month never satisfy a requiredCount of 3", () => {
    const result = computeRequirementSatisfaction(3, ["01/2026", "01/2026", "01/2026"]);
    expect(result).toEqual({ satisfiedCount: 1, satisfied: false });
  });

  it("treats an undated document (null label) as its own distinct unit — never blocks on an extraction gap", () => {
    const result = computeRequirementSatisfaction(3, [null, null, null]);
    expect(result).toEqual({ satisfiedCount: 3, satisfied: true });
  });

  it("mixes dated and undated documents correctly", () => {
    const result = computeRequirementSatisfaction(3, ["01/2026", null, "01/2026"]);
    // 1 distinct label ("01/2026") + 1 undated unit = 2.
    expect(result).toEqual({ satisfiedCount: 2, satisfied: false });
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
