import { describe, expect, it } from "vitest";
import { classifyClientBusinessType, type BusinessTypeCandidate } from "./businessTypeClassifier";

const CANDIDATES: BusinessTypeCandidate[] = [
  { id: "ltd", name: 'חברה בע"מ' },
  { id: "authorized", name: "עוסק מורשה" },
  { id: "exempt", name: "עוסק פטור" },
  { id: "nonprofit", name: "עמותה" },
  { id: "payroll", name: "שכר בלבד" },
];

describe("classifyClientBusinessType — deterministic dictionary match", () => {
  const cases: Array<[string, string]> = [
    ['חברה בע"מ', "ltd"],
    ["חברה", "ltd"],
    ["עוסק מורשה", "authorized"],
    ["מורשה", "authorized"],
    ["עוסק פטור", "exempt"],
    ["פטור", "exempt"],
    ["עמותה", "nonprofit"],
    ["שכר בלבד", "payroll"],
  ];

  for (const [explicitBusinessType, expectedId] of cases) {
    it(`maps "${explicitBusinessType}" to the correct candidate`, async () => {
      const result = await classifyClientBusinessType("לקוח כלשהו", CANDIDATES, explicitBusinessType);
      expect(result.businessTypeId).toBe(expectedId);
      expect(result.method).toBe("explicit-dictionary");
      expect(result.confidence).toBe(1);
    });
  }

  it("matches even when the column value has extra surrounding text", async () => {
    const result = await classifyClientBusinessType(
      "לקוח כלשהו",
      CANDIDATES,
      "  עוסק מורשה (שכיר בעבר)  "
    );
    expect(result.businessTypeId).toBe("authorized");
  });

  it("falls back to matching the client's own name when no explicit column is given", async () => {
    const result = await classifyClientBusinessType('כהן ושות\' בע"מ', CANDIDATES, undefined);
    expect(result.businessTypeId).toBe("ltd");
    expect(result.method).toBe("name-dictionary");
    expect(result.confidence).toBeLessThan(1);
  });

  it("returns unclassified when nothing matches", async () => {
    const result = await classifyClientBusinessType("ישראל ישראלי", CANDIDATES, undefined);
    expect(result.businessTypeId).toBeNull();
    expect(result.method).toBe("unclassified");
    expect(result.confidence).toBe(0);
  });

  it("does not classify against a type the organization hasn't actually created", async () => {
    const onlyLtd: BusinessTypeCandidate[] = [{ id: "ltd", name: 'חברה בע"מ' }];
    const result = await classifyClientBusinessType("לקוח", onlyLtd, "עוסק פטור");
    expect(result.businessTypeId).toBeNull();
  });
});
