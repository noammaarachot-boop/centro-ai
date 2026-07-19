import { describe, expect, it } from "vitest";
import {
  classifyClientBusinessType,
  matchSynonym,
  type BusinessTypeCandidate,
} from "./businessTypeClassifier";

const CANDIDATES: BusinessTypeCandidate[] = [
  { id: "ltd", name: 'חברה בע"מ', canonicalKey: "limited_company" },
  { id: "authorized", name: "עוסק מורשה", canonicalKey: "authorized_dealer" },
  { id: "exempt", name: "עוסק פטור", canonicalKey: "exempt_dealer" },
  { id: "nonprofit", name: "עמותה", canonicalKey: "nonprofit" },
  { id: "payroll", name: "שכר בלבד", canonicalKey: "payroll_only" },
];

describe("matchSynonym", () => {
  it("maps every documented synonym form to its canonical key", () => {
    const cases: Array<[string, string]> = [
      ['חברה בע"מ', "limited_company"],
      ["בעמ", "limited_company"],
      ["חברה", "limited_company"],
      ["Limited Company", "limited_company"],
      ["עוסק מורשה", "authorized_dealer"],
      ["ע. מורשה", "authorized_dealer"],
      ["מורשה", "authorized_dealer"],
      ["Sole Proprietor", "authorized_dealer"],
      ["עוסק פטור", "exempt_dealer"],
      ["ע. פטור", "exempt_dealer"],
      ["פטור", "exempt_dealer"],
      ["Exempt Business", "exempt_dealer"],
      ["עמותה", "nonprofit"],
      ['מלכ"ר', "nonprofit"],
      ['חל"צ', "nonprofit"],
      ["Nonprofit", "nonprofit"],
      ["שכר בלבד", "payroll_only"],
      ["Payroll", "payroll_only"],
      ["Payroll Only", "payroll_only"],
    ];
    for (const [text, expected] of cases) {
      expect(matchSynonym(text), `"${text}"`).toBe(expected);
    }
  });

  it("returns null for text with no business-type signal", () => {
    expect(matchSynonym("תל אביב")).toBeNull();
    expect(matchSynonym("")).toBeNull();
  });
});

describe("classifyClientBusinessType — layer 1: explicit column", () => {
  it("classifies at 99% confidence from an exact/synonym match on the explicit column", async () => {
    const result = await classifyClientBusinessType(
      { clientName: "לקוח כלשהו", explicitBusinessType: "עוסק מורשה" },
      CANDIDATES
    );
    expect(result.businessTypeId).toBe("authorized");
    expect(result.canonicalKey).toBe("authorized_dealer");
    expect(result.method).toBe("explicit-dictionary");
    expect(result.confidence).toBe(99);
    expect(result.reason).toBeTruthy();
  });

  it("matches even when the column value has extra surrounding text", async () => {
    const result = await classifyClientBusinessType(
      { clientName: "לקוח כלשהו", explicitBusinessType: "  עוסק מורשה (שכיר בעבר)  " },
      CANDIDATES
    );
    expect(result.businessTypeId).toBe("authorized");
  });

  it("does not classify against a type the organization hasn't actually created", async () => {
    const onlyLtd: BusinessTypeCandidate[] = [
      { id: "ltd", name: 'חברה בע"מ', canonicalKey: "limited_company" },
    ];
    const result = await classifyClientBusinessType(
      { clientName: "לקוח", explicitBusinessType: "עוסק פטור" },
      onlyLtd
    );
    expect(result.businessTypeId).toBeNull();
  });
});

describe("classifyClientBusinessType — layer 2: context inference", () => {
  it("falls back to the client's own name when no explicit column is given", async () => {
    const result = await classifyClientBusinessType(
      { clientName: 'כהן ושות\' בע"מ' },
      CANDIDATES
    );
    expect(result.businessTypeId).toBe("ltd");
    expect(result.method).toBe("context-inference");
    expect(result.confidence).toBe(85);
  });

  it("searches the rest of the row when name and explicit column both fail", async () => {
    const result = await classifyClientBusinessType(
      {
        clientName: "עמותת אור לילד",
        explicitBusinessType: "",
        otherValues: ["תל אביב", "0501234567"],
      },
      CANDIDATES
    );
    // "עמותת" is embedded in the client's own name itself here — still layer 2.
    expect(result.businessTypeId).toBe("nonprofit");
    expect(result.method).toBe("context-inference");
  });

  it("finds a signal in otherValues when the name has none", async () => {
    const result = await classifyClientBusinessType(
      {
        clientName: "ישראל ישראלי",
        otherValues: ["תל אביב", 'עוסק פטור לפי מסמכים ישנים'],
      },
      CANDIDATES
    );
    expect(result.businessTypeId).toBe("exempt");
    expect(result.method).toBe("context-inference");
  });
});

describe("classifyClientBusinessType — never guesses", () => {
  it("returns unclassified with confidence 0 when nothing matches anywhere in the row", async () => {
    const result = await classifyClientBusinessType(
      { clientName: "ישראל ישראלי", otherValues: ["תל אביב"] },
      CANDIDATES
    );
    expect(result.businessTypeId).toBeNull();
    expect(result.method).toBe("unclassified");
    expect(result.confidence).toBe(0);
    expect(result.reason).toBeTruthy();
  });
});

describe("classifyClientBusinessType — learned synonyms (per-organization)", () => {
  it("prefers a learned synonym over the global dictionary, at 99% confidence", async () => {
    const learned = new Map([["מורשה מיוחד", "exempt"]]); // this office's own shorthand
    const result = await classifyClientBusinessType(
      { clientName: "לקוח", explicitBusinessType: "מורשה מיוחד" },
      CANDIDATES,
      learned
    );
    expect(result.businessTypeId).toBe("exempt");
    expect(result.method).toBe("learned-synonym");
    expect(result.confidence).toBe(99);
  });

  it("checks learned synonyms during context inference too", async () => {
    const learned = new Map([["חברת בת מקומית", "ltd"]]);
    const result = await classifyClientBusinessType(
      { clientName: "לקוח", otherValues: ["חברת בת מקומית"] },
      CANDIDATES,
      learned
    );
    expect(result.businessTypeId).toBe("ltd");
    expect(result.method).toBe("context-inference");
    expect(result.confidence).toBe(85);
  });

  it("ignores a learned synonym belonging to a candidate the org no longer has", async () => {
    const learned = new Map([["מורשה מיוחד", "some-deleted-type-id"]]);
    const result = await classifyClientBusinessType(
      { clientName: "לקוח", explicitBusinessType: "מורשה מיוחד" },
      CANDIDATES,
      learned
    );
    // Falls through to the global dictionary, which also doesn't recognize
    // "מורשה מיוחד" verbatim (only "מורשה" alone) — still resolves via the
    // substring synonym match, proving the fallback chain, not the learned
    // entry, is what decided this.
    expect(result.businessTypeId).toBe("authorized");
    expect(result.method).toBe("explicit-dictionary");
  });
});
