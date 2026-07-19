import { describe, expect, it } from "vitest";
import {
  analyzeColumns,
  analyzeColumnsWithAIFallback,
  extractRowContextValues,
  isBusinessTypeLike,
  isCityLike,
  isEmailLike,
  isNameLike,
  isNineDigitIdLike,
  isPhoneLike,
} from "./columnAnalyzer";
import { buildClientRowsFromMapping } from "@/lib/csv";

describe("value-pattern detectors", () => {
  it("recognizes Israeli phone numbers across real-world formats", () => {
    const valid = [
      "0501234567", // mobile, no separators
      "050-1234567", // mobile, dash
      "050 123 4567", // mobile, spaces
      "(050) 123-4567", // mobile, parens + dash
      "+972-50-1234567", // international, dashes
      "+972501234567", // international, no separators
      "00972501234567", // international dial-out prefix
      "03-1234567", // landline
      "021234567", // landline, no separators
      "501234567", // mobile stored as a number, leading 0 lost
      "21234567", // landline stored as a number, leading 0 lost
    ];
    for (const value of valid) {
      expect(isPhoneLike(value), `expected "${value}" to be phone-like`).toBe(true);
    }
  });

  it("rejects values that are not phone numbers", () => {
    for (const value of ["", "1", "12345", "abc-defg", "דנה כהן", "d@x.com"]) {
      expect(isPhoneLike(value), `expected "${value}" not to be phone-like`).toBe(false);
    }
  });

  it("recognizes email addresses and rejects everything else", () => {
    expect(isEmailLike("dana@example.com")).toBe(true);
    expect(isEmailLike("not-an-email")).toBe(false);
    expect(isEmailLike("0501234567")).toBe(false);
  });

  it("treats both person and company names as name-like, but not phones/emails", () => {
    expect(isNameLike("דנה כהן")).toBe(true);
    expect(isNameLike('אבגד בע"מ')).toBe(true);
    expect(isNameLike("Acme Ltd.")).toBe(true);
    expect(isNameLike("0501234567")).toBe(false);
    expect(isNameLike("dana@example.com")).toBe(false);
    expect(isNameLike("")).toBe(false);
  });

  it("recognizes business-type values in Hebrew and English, exact and shorthand", () => {
    for (const value of [
      'חברה בע"מ',
      "חברה",
      'בע"מ',
      "עוסק מורשה",
      "מורשה",
      "עוסק פטור",
      "פטור",
      "עמותה",
      "שכר בלבד",
      "Payroll",
      "Limited Company",
      "Sole Proprietor",
      "Exempt Business",
      "Nonprofit",
    ]) {
      expect(isBusinessTypeLike(value), `expected "${value}" to be business-type-like`).toBe(true);
    }
    expect(isBusinessTypeLike("תל אביב")).toBe(false);
    expect(isBusinessTypeLike("")).toBe(false);
  });

  it("recognizes known Israeli city names, Hebrew and English", () => {
    expect(isCityLike("תל אביב")).toBe(true);
    expect(isCityLike("ירושלים")).toBe(true);
    expect(isCityLike("Tel Aviv")).toBe(true);
    expect(isCityLike("Some Random Place")).toBe(false);
  });

  it("recognizes plain and dash-separated 9-digit IDs (company/tax numbers)", () => {
    expect(isNineDigitIdLike("512345678")).toBe(true);
    expect(isNineDigitIdLike("51-234567-8")).toBe(true);
    expect(isNineDigitIdLike("12345")).toBe(false);
    expect(isNineDigitIdLike("abc")).toBe(false);
  });
});

// A realistic 12-row file with entirely generic/unknown headers — nothing
// here matches any header alias, so every assignment below is driven
// purely by cell content, exercising the requirement that headers are
// never the only signal.
const GENERIC_HEADER_ROWS: string[][] = [
  ["Column A", "Column B", "Column C", "Column D", "Column E"],
  ["דנה כהן", "0501111111", "dana@x.com", 'חברה בע"מ', "2020-01-01"],
  ["משה לוי", "050-222-2222", "moshe@x.com", "עוסק מורשה", "2020-01-02"],
  ["רותם ישראלי", "03-3333333", "", "עוסק פטור", "2020-01-03"],
  ['עמותת הלב הפתוח', "+972-54-4444444", "info@lev.org", "עמותה", "2020-01-04"],
  ["שירותי שכר בע\"מ", "0555555555", "", "שכר בלבד", "2020-01-05"],
  ["יעל אברהם", "0506666666", "yael@x.com", "Ltd", "2020-01-06"],
  ["דוד מזרחי", "0507777777", "", "Sole Proprietor", "2020-01-07"],
  ["רחל שפירא", "0508888888", "", "Exempt Business", "2020-01-08"],
  ["עמותת הילדים", "0509999999", "", "Nonprofit", "2020-01-09"],
  ["אבי פרץ", "0501010101", "", 'בע"מ', "2020-01-10"],
  ["נועה גולן", "0502020202", "", "מורשה", "2020-01-11"],
];

describe("analyzeColumns — realistic files with unknown headers", () => {
  it("infers name/phone/email/business-type purely from content when headers are generic", () => {
    const result = analyzeColumns(GENERIC_HEADER_ROWS);
    expect(result.mapping.name).toBe(0);
    expect(result.mapping.phone).toBe(1);
    expect(result.mapping.email).toBe(2);
    expect(result.mapping.businessType).toBe(3);
    expect(result.confidence).toBe("high");
  });

  it("does not map the unrelated date column to any role", () => {
    const result = analyzeColumns(GENERIC_HEADER_ROWS);
    const mappedIndices = Object.values(result.mapping);
    expect(mappedIndices).not.toContain(4);
  });

  it("builds correct client rows once headers are confirmed", () => {
    const result = analyzeColumns(GENERIC_HEADER_ROWS);
    const dataRows = GENERIC_HEADER_ROWS.slice(1);
    const clientRows = buildClientRowsFromMapping(dataRows, result.mapping);
    expect(clientRows[0]).toEqual({
      name: "דנה כהן",
      phone: "0501111111",
      email: "dana@x.com",
      notes: "",
      businessType: 'חברה בע"מ',
      otherValues: ["2020-01-01"],
    });
  });
});

describe("analyzeColumns — missing header row", () => {
  it("detects that the first row is data (not labels) and still resolves the columns", () => {
    const rows: string[][] = [
      ["דנה כהן", "0501111111", 'חברה בע"מ'],
      ["משה לוי", "0502222222", "עוסק מורשה"],
      ["רותם ישראלי", "0503333333", "עוסק פטור"],
      ["עמותת הלב הפתוח", "0504444444", "עמותה"],
      ["שירותי שכר", "0505555555", "שכר בלבד"],
      ["יעל אברהם", "0506666666", 'חברה בע"מ'],
    ];
    const result = analyzeColumns(rows);
    expect(result.hasHeaderRow).toBe(false);
    expect(result.mapping.name).toBe(0);
    expect(result.mapping.phone).toBe(1);
    expect(result.mapping.businessType).toBe(2);
    // Synthesized headers, since there is no real header row to read.
    expect(result.headers[0]).toMatch(/עמודה/);
  });
});

describe("analyzeColumns — mixed valid and invalid business-type values", () => {
  it("still identifies the business-type column despite noisy rows, without forcing bad matches", () => {
    const rows: string[][] = [
      ["name", "phone", "type"],
      ["דנה כהן", "0501111111", 'חברה בע"מ'],
      ["משה לוי", "0502222222", "עוסק מורשה"],
      ["רותם ישראלי", "0503333333", "עוסק פטור"],
      ['עמותת הלב הפתוח', "0504444444", "עמותה"],
      ["שירותי שכר", "0505555555", "שכר בלבד"],
      ["יעל אברהם", "0506666666", "תל אביב"], // city name — noise
      ["דוד מזרחי", "0507777777", "הערה כללית"], // random note — noise
      ["רחל שפירא", "0508888888", ""], // empty — noise
      ["עמותת הילדים", "0509999999", "42"], // number — noise
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.businessType).toBe(2);
    expect(result.confidence).toBe("high");

    // The row-level classifier (not this module) is what decides per-row
    // whether a specific value is usable — this module's job is only to
    // find the column. Noisy individual values must not corrupt that.
    const dataRows = rows.slice(1);
    const clientRows = buildClientRowsFromMapping(dataRows, result.mapping);
    expect(clientRows[5].businessType).toBe("תל אביב"); // city noise — passed through as-is
    expect(clientRows[7].businessType).toBe(""); // empty stays empty
    expect(clientRows[8].businessType).toBe("42"); // numeric noise — passed through, not forced
  });
});

describe("analyzeColumns — company names instead of person names", () => {
  it("identifies a name column made of company names without confusing it for business type", () => {
    const rows: string[][] = [
      ["A", "B", "C"],
      ['אבגד בע"מ', "0501111111", 'חברה בע"מ'],
      ['שירותי הנהלת חשבונות בע"מ', "0502222222", 'חברה בע"מ'],
      ['כהן ושות\' בע"מ', "0503333333", "עוסק מורשה"],
      ["דוד מזרחי ובניו בע\"מ", "0504444444", "עוסק מורשה"],
      ['מזרחי אחזקות בע"מ', "0505555555", "עמותה"],
      ['לוי ייעוץ עסקי בע"מ', "0506666666", "עמותה"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.name).toBe(0);
    expect(result.mapping.businessType).toBe(2);
    expect(result.mapping.name).not.toBe(result.mapping.businessType);
  });
});

describe("analyzeColumns — shuffled column order", () => {
  it("does not let a business-type column steal the name role when it appears before the real name column", () => {
    // Regression: with no headers, a business-type column full of varied
    // synonym forms (each string literally unique) can score identically
    // to the real name column on "name" (same pattern/structure signals).
    // When that column's index is lower than the real name column's, a
    // naive first-wins tie-break picks the wrong one.
    const rows: string[][] = [
      ["0501111111", 'חברה בע"מ', "דנה כהן"],
      ["0502222222", "מורשה", "משה לוי"],
      ["0503333333", "פטור", "רותם ישראלי"],
      ["0504444444", "עמותה", "עמותת הלב הפתוח"],
      ["0505555555", "Payroll", "שירותי שכר"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.phone).toBe(0);
    expect(result.mapping.businessType).toBe(1);
    expect(result.mapping.name).toBe(2);
  });
});

describe("analyzeColumns — extra unrelated columns", () => {
  it("leaves columns with no plausible role unmapped", () => {
    const rows: string[][] = [
      ["ID", "name", "phone", "batch_ref", "email"],
      ["1001", "דנה כהן", "0501111111", "X-92-A", "dana@x.com"],
      ["1002", "משה לוי", "0502222222", "X-14-B", "moshe@x.com"],
      ["1003", "רותם ישראלי", "0503333333", "X-77-C", "rotem@x.com"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.name).toBe(1);
    expect(result.mapping.phone).toBe(2);
    expect(result.mapping.email).toBe(4);
    expect(result.mapping.businessType).toBeUndefined();
    expect(Object.values(result.mapping)).not.toContain(0); // ID column
    expect(Object.values(result.mapping)).not.toContain(3); // batch_ref column
  });
});

describe("analyzeColumns — ragged rows", () => {
  it("does not crash when a row is shorter than the header row", () => {
    const rows: string[][] = [
      ["name", "phone", "email"],
      ["דנה כהן", "0501111111", "dana@x.com"],
      ["משה לוי", "0502222222"], // missing trailing email cell
    ];
    expect(() => analyzeColumns(rows)).not.toThrow();
    const result = analyzeColumns(rows);
    const dataRows = rows.slice(1);
    const clientRows = buildClientRowsFromMapping(dataRows, result.mapping);
    expect(clientRows[1].email).toBe("");
  });
});

describe("analyzeColumns — duplicate clients", () => {
  it("still identifies the phone column even with a couple of repeated numbers", () => {
    const rows: string[][] = [
      ["name", "phone"],
      ["דנה כהן", "0501111111"],
      ["משה לוי", "0502222222"],
      ["רותם ישראלי", "0503333333"],
      ["עמותת הלב הפתוח", "0501111111"], // duplicate of row 1's number
      ["שירותי שכר", "0505555555"],
      ["יעל אברהם", "0506666666"],
      ["דוד מזרחי", "0507777777"],
      ["רחל שפירא", "0501111111"], // duplicate again
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.phone).toBe(1);
    expect(result.confidence).toBe("high");
  });
});

describe("analyzeColumns — low confidence and manual correction", () => {
  it("flags low confidence when there is no plausible phone column at all", () => {
    const rows: string[][] = [
      ["A", "B"],
      ["דנה כהן", "הערה כלשהי"],
      ["משה לוי", "הערה נוספת"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.phone).toBeUndefined();
    expect(result.confidence).toBe("low");
  });

  it("still produces correct client rows once a human manually maps every column", () => {
    // A file the deterministic analyzer alone can't confidently resolve —
    // this exercises the exact path the wizard's mapping-confirmation
    // screen exists for (requirement 8): a human picks the columns, and
    // buildClientRowsFromMapping just plucks them, no inference involved.
    const rows: string[][] = [
      ["col1", "col2"],
      ["דנה כהן", "1"],
      ["משה לוי", "2"],
    ];
    const dataRows = rows.slice(1);
    const manualMapping = { name: 0, phone: 1 };
    const clientRows = buildClientRowsFromMapping(dataRows, manualMapping);
    expect(clientRows).toEqual([
      { name: "דנה כהן", phone: "1", email: "", notes: "", businessType: "", otherValues: [] },
      { name: "משה לוי", phone: "2", email: "", notes: "", businessType: "", otherValues: [] },
    ]);
  });
});

describe("analyzeColumns — bonus roles (city, company ID, tax ID)", () => {
  it("detects a city column as a best-effort bonus, never blocking confidence", () => {
    const rows: string[][] = [
      ["name", "phone", "city"],
      ["דנה כהן", "0501111111", "תל אביב"],
      ["משה לוי", "0502222222", "ירושלים"],
      ["רותם ישראלי", "0503333333", "תל אביב"],
      ["עמותת הלב הפתוח", "0504444444", "חיפה"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.city).toBe(2);
    expect(result.confidence).toBe("high");
  });

  it("detects a company-ID column primarily via header hint (content alone is ambiguous)", () => {
    const rows: string[][] = [
      ["name", "phone", 'ח.פ'],
      ["דנה כהן", "0501111111", "512345678"],
      ["משה לוי", "0502222222", "523456789"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.companyId).toBe(2);
  });

  it("never lets a bonus role steal the real phone column", () => {
    const rows: string[][] = [
      ["name", "phone", 'ח.פ'],
      ["דנה כהן", "0501111111", "512345678"],
      ["משה לוי", "0502222222", "523456789"],
      ["רותם ישראלי", "0503333333", "534567890"],
    ];
    const result = analyzeColumns(rows);
    expect(result.mapping.phone).toBe(1);
    expect(result.mapping.companyId).toBe(2);
  });
});

describe("extractRowContextValues", () => {
  it("excludes name/phone/email/businessType and includes everything else", () => {
    const row = ["דנה כהן", "0501111111", "dana@x.com", 'חברה בע"מ', "תל אביב", "הערה"];
    const mapping = { name: 0, phone: 1, email: 2, businessType: 3, city: 4, notes: 5 };
    expect(extractRowContextValues(row, mapping)).toEqual(["תל אביב", "הערה"]);
  });

  it("includes an entirely unmapped column too", () => {
    const row = ["דנה כהן", "0501111111", "some unrecognized extra value"];
    const mapping = { name: 0, phone: 1 };
    expect(extractRowContextValues(row, mapping)).toEqual(["some unrecognized extra value"]);
  });

  it("skips empty cells", () => {
    const row = ["דנה כהן", "0501111111", ""];
    const mapping = { name: 0, phone: 1 };
    expect(extractRowContextValues(row, mapping)).toEqual([]);
  });
});

describe("analyzeColumnsWithAIFallback", () => {
  it("returns the deterministic result unchanged when confidence is already high", async () => {
    const result = await analyzeColumnsWithAIFallback(GENERIC_HEADER_ROWS);
    expect(result.confidence).toBe("high");
    expect(result.mapping.name).toBe(0);
  });

  it("falls back to the deterministic (low-confidence) result when the AI stub is a no-op", async () => {
    const rows: string[][] = [
      ["A", "B"],
      ["דנה כהן", "הערה כלשהי"],
    ];
    const result = await analyzeColumnsWithAIFallback(rows);
    // No AI provider is configured (documented no-op stub) — deterministic
    // low-confidence result passes through unchanged rather than being
    // silently upgraded to a fake "high" confidence.
    expect(result.confidence).toBe("low");
  });
});
