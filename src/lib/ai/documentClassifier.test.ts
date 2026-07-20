import { describe, expect, it } from "vitest";
import {
  classifyDocument,
  classifyDocumentWithLearning,
  isFuzzyDuplicate,
  matchLearnedPattern,
  type DocumentClassificationCandidate,
  type LearnedDocumentPattern,
} from "./documentClassifier";

const CANDIDATES: DocumentClassificationCandidate[] = [
  { id: "req-bank", name: "Bank Statement", sourceRequirementId: "src-bank" },
  { id: "req-invoice", name: "Income Invoices", sourceRequirementId: "src-invoice" },
];

describe("classifyDocument — plain deterministic heuristic (Business Rules layer)", () => {
  it("matches a filename to the requirement with the best token overlap", async () => {
    const result = await classifyDocument("bank-statement-january.pdf", CANDIDATES);
    expect(result.matchedRequirementId).toBe("req-bank");
    expect(result.supported).toBe(true);
    expect(result.readable).toBe(true);
  });

  it("rejects unsupported extensions before any matching", async () => {
    const result = await classifyDocument("bank-statement.exe", CANDIDATES);
    expect(result.supported).toBe(false);
    expect(result.matchedRequirementId).toBeNull();
  });

  it("flags a suspiciously short base name as unreadable", async () => {
    const result = await classifyDocument("a.pdf", CANDIDATES);
    expect(result.supported).toBe(true);
    expect(result.readable).toBe(false);
  });

  it("returns no match when nothing overlaps", async () => {
    const result = await classifyDocument("random-file.pdf", CANDIDATES);
    expect(result.matchedRequirementId).toBeNull();
  });
});

describe("matchLearnedPattern", () => {
  const learned: LearnedDocumentPattern[] = [
    { sourceRequirementId: "src-bank", fileName: "bank_statement_january.pdf" },
    { sourceRequirementId: "src-invoice", fileName: "invoice_client_march.pdf" },
  ];

  it("finds a similar previously-confirmed filename above the threshold", () => {
    const result = matchLearnedPattern("bank_statement_february.pdf", learned);
    expect(result?.sourceRequirementId).toBe("src-bank");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns null when nothing is similar enough", () => {
    const result = matchLearnedPattern("completely-unrelated-file.pdf", learned);
    expect(result).toBeNull();
  });

  it("returns null when there is no learning history at all", () => {
    expect(matchLearnedPattern("bank_statement_february.pdf", [])).toBeNull();
  });

  it("does not match two otherwise-unrelated files purely because they share an extension", () => {
    // Regression, found via a real end-to-end test: "pdf" was previously
    // counted as a shared token like any other word, so any two PDFs got
    // a free point of similarity — enough, on its own, to push an
    // unrelated pair over threshold. "טופס_נוסף" ("another form") and
    // "טופס_102" share only the word "טופס" ("form") once the extension
    // is correctly excluded, well under the threshold.
    const learned: LearnedDocumentPattern[] = [
      { sourceRequirementId: "src-bank", fileName: "טופס_102.pdf" },
    ];
    expect(matchLearnedPattern("טופס_נוסף.pdf", learned)).toBeNull();
  });
});

describe("classifyDocumentWithLearning — full 4-layer pipeline", () => {
  it("prefers a learned pattern over the generic heuristic (Ch.6: Learned Knowledge first)", async () => {
    // "employee-payroll-form.pdf" wouldn't match either candidate by name
    // overlap alone, but this exact client has taught Centro it belongs
    // to req-invoice.
    const learned: LearnedDocumentPattern[] = [
      { sourceRequirementId: "src-invoice", fileName: "employee-payroll-form-january.pdf" },
    ];
    const result = await classifyDocumentWithLearning(
      "employee-payroll-form-february.pdf",
      CANDIDATES,
      learned
    );
    expect(result.matchedRequirementId).toBe("req-invoice");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("falls back to the generic heuristic when nothing is learned yet, producing identical results to calling it directly", async () => {
    const withLearning = await classifyDocumentWithLearning("bank-statement-january.pdf", CANDIDATES, []);
    const direct = await classifyDocument("bank-statement-january.pdf", CANDIDATES);
    expect(withLearning).toEqual(direct);
  });

  it("ignores a learned pattern whose requirement isn't offered this cycle", async () => {
    const learned: LearnedDocumentPattern[] = [
      { sourceRequirementId: "src-deleted", fileName: "old-form-january.pdf" },
    ];
    const result = await classifyDocumentWithLearning("old-form-february.pdf", CANDIDATES, learned);
    expect(result.matchedRequirementId).toBeNull();
  });

  it("still gates unsupported/unreadable files before any learned check", async () => {
    const learned: LearnedDocumentPattern[] = [
      { sourceRequirementId: "src-bank", fileName: "a.pdf" },
    ];
    const result = await classifyDocumentWithLearning("a.pdf", CANDIDATES, learned);
    expect(result.readable).toBe(false);
    expect(result.matchedRequirementId).toBeNull();
  });

  it("never guesses — returns no match when neither learned nor generic matching finds anything", async () => {
    const result = await classifyDocumentWithLearning("totally-unrelated.pdf", CANDIDATES, []);
    expect(result.matchedRequirementId).toBeNull();
    expect(result.confidence).toBe(0);
  });
});

describe("isFuzzyDuplicate — unchanged by this milestone", () => {
  it("still treats a high-token-overlap renamed copy as a duplicate", () => {
    expect(isFuzzyDuplicate("bank-statement-jan.pdf", "bank-statement-jan-copy.pdf")).toBe(true);
  });

  it("still treats unrelated files as not duplicates", () => {
    expect(isFuzzyDuplicate("bank-statement.pdf", "invoice.pdf")).toBe(false);
  });
});
