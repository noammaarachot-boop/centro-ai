import { beforeEach, describe, expect, it, vi } from "vitest";

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("./documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
}));

beforeEach(() => {
  classifyDocumentViaVisionAI.mockReset();
});

import { resolveDocumentIntakeOutcome } from "../documentIntakeReview";
import {
  AUTO_APPROVE_CONFIDENCE,
  classifyDocument,
  classifyDocumentWithLearning,
  isFuzzyDuplicate,
  matchLearnedPattern,
  resolveRequirementAssignment,
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

  it("never guesses — returns no match when neither learned nor generic matching finds anything, and no fileContent was given", async () => {
    const result = await classifyDocumentWithLearning("totally-unrelated.pdf", CANDIDATES, []);
    expect(result.matchedRequirementId).toBeNull();
    expect(result.confidence).toBe(0);
    expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled();
  });

  it("layer 3 (AI): falls through to vision classification when fileContent is given and nothing else matched — this is the real path for a WhatsApp photo, whose generated filename (image_<wamid>.jpg) never matches on tokens", async () => {
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "Bank Statement",
      identificationConfidence: 0.9,
      matchedRequirementId: "req-bank",
      matchConfidence: 0.88,
    });
    const result = await classifyDocumentWithLearning(
      "image_wamid.abc123.jpg",
      CANDIDATES,
      [],
      { bytes: Buffer.from("fake-bytes"), mimeType: "image/jpeg" }
    );
    expect(result.matchedRequirementId).toBe("req-bank");
    expect(result.confidence).toBe(0.88);
    expect(classifyDocumentViaVisionAI).toHaveBeenCalledWith(
      expect.any(Buffer),
      "image/jpeg",
      CANDIDATES
    );
  });

  it("layer 3 (AI): no match, but carries the AI's identification signal through — this is what lets the caller tell 'identified as something else' apart from 'genuinely unrecognized'", async () => {
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס קבלה",
      identificationConfidence: 0.97,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    const result = await classifyDocumentWithLearning(
      "image_wamid.xyz.jpg",
      CANDIDATES,
      [],
      { bytes: Buffer.from("fake-bytes"), mimeType: "image/jpeg" }
    );
    expect(result.matchedRequirementId).toBeNull();
    expect(result.aiRan).toBe(true);
    expect(result.aiIdentified).toBe(true);
    expect(result.aiDocumentType).toBe("חשבונית מס קבלה");
  });

  it("layer 3 (AI): identified=false when the AI genuinely can't tell what the document is", async () => {
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.1,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    const result = await classifyDocumentWithLearning(
      "image_wamid.blurry.jpg",
      CANDIDATES,
      [],
      { bytes: Buffer.from("fake-bytes"), mimeType: "image/jpeg" }
    );
    expect(result.matchedRequirementId).toBeNull();
    expect(result.aiRan).toBe(true);
    expect(result.aiIdentified).toBe(false);
  });

  // A real production case: a long, descriptive requirement name mechanically
  // dilutes the deterministic filename-token-overlap score even for a
  // perfectly correct file, so a weak (but present) matchedRequirementId
  // must never, on its own, be trusted enough to skip real content
  // classification — only a match that actually clears AUTO_APPROVE_CONFIDENCE
  // earns that. See classifyDocumentWithLearning's own doc comment for the
  // full incident.
  describe("weak filename matches always defer to real AI content classification", () => {
    const VERBOSE_CANDIDATES: DocumentClassificationCandidate[] = [
      ...CANDIDATES,
      { id: "req-payslip", name: "3 תלושי שכר של 3 החודשים האחרונים", sourceRequirementId: "src-payslip" },
    ];

    it("1. a strong, correct filename match still skips AI entirely (unaffected by the fix)", async () => {
      const result = await classifyDocumentWithLearning("bank-statement-january.pdf", VERBOSE_CANDIDATES, []);
      expect(result.matchedRequirementId).toBe("req-bank");
      expect(result.confidence).toBeGreaterThanOrEqual(AUTO_APPROVE_CONFIDENCE);
      expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled();
    });

    it("2. a weak filename match whose content genuinely matches the same requirement is confirmed by AI, not filed as unrecognized", async () => {
      const weak = await classifyDocument("05_תלוש_שכר_יולי.pdf", VERBOSE_CANDIDATES);
      expect(weak.matchedRequirementId).toBe("req-payslip"); // present, but...
      expect(weak.confidence).toBeLessThan(AUTO_APPROVE_CONFIDENCE); // ...too weak to trust alone

      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: "req-payslip",
        matchConfidence: 0.92,
      });
      const result = await classifyDocumentWithLearning(
        "05_תלוש_שכר_יולי.pdf",
        VERBOSE_CANDIDATES,
        [],
        { bytes: Buffer.from("fake-bytes"), mimeType: "application/pdf" }
      );
      expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1); // the actual bug: this must run
      expect(result.matchedRequirementId).toBe("req-payslip");
      expect(result.confidence).toBe(0.92);
      expect(result.aiRan).toBe(true);
    });

    it("3. a weak filename match whose content is a genuinely different, unrequested document routes to unsolicited, not unrecognized", async () => {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "קבלה על תיקון רכב",
        identificationConfidence: 0.93,
        matchedRequirementId: null,
        matchConfidence: 0,
      });
      const result = await classifyDocumentWithLearning(
        "תלוש_על_זה_ולא_על_זה.pdf", // weak/no filename overlap by itself
        VERBOSE_CANDIDATES,
        [],
        { bytes: Buffer.from("fake-bytes"), mimeType: "application/pdf" }
      );
      expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
      expect(result.aiRan).toBe(true);
      expect(result.aiIdentified).toBe(true);
      expect(result.aiDocumentType).toBe("קבלה על תיקון רכב");
      // The end-to-end contract that actually matters: whatever weak
      // matchedRequirementId lingers on the raw classification (kept only
      // for the sole-outstanding-requirement fallback), the real intake
      // decision must still be "unsolicited" — the AI's confident
      // identification always wins over a leftover weak filename guess.
      expect(resolveDocumentIntakeOutcome(result, ["req-bank", "req-invoice", "req-payslip"])).toEqual({
        kind: "unsolicited",
        documentType: "קבלה על תיקון רכב",
      });
    });

    it("4. a misleading weak filename match never wins over the AI's own real classification of the actual document", async () => {
      // Filename happens to weakly overlap with "Income Invoices" (via
      // "income"), but the real file is actually a bank statement.
      const misleading = await classifyDocument("income-related-scan.pdf", CANDIDATES);
      expect(misleading.confidence).toBeLessThan(AUTO_APPROVE_CONFIDENCE);

      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "Bank Statement",
        identificationConfidence: 0.94,
        matchedRequirementId: "req-bank",
        matchConfidence: 0.9,
      });
      const result = await classifyDocumentWithLearning(
        "income-related-scan.pdf",
        CANDIDATES,
        [],
        { bytes: Buffer.from("fake-bytes"), mimeType: "application/pdf" }
      );
      expect(result.matchedRequirementId).toBe("req-bank"); // the AI's real answer, not the misleading filename guess
      expect(result.confidence).toBe(0.9);
    });

    it("5. a weak filename hint never blocks AI from running, and the AI genuinely failing to identify still reaches needs_resend territory (null match)", async () => {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: false,
        documentType: null,
        identificationConfidence: 0.1,
        matchedRequirementId: null,
        matchConfidence: 0,
      });
      const result = await classifyDocumentWithLearning(
        "05_תלוש_שכר_יולי.pdf",
        VERBOSE_CANDIDATES,
        [],
        { bytes: Buffer.from("fake-bytes"), mimeType: "application/pdf" }
      );
      expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
      expect(result.aiRan).toBe(true);
      expect(result.aiIdentified).toBe(false);
      // End-to-end: with more than one requirement still outstanding, the
      // leftover weak filename guess must never be trusted as a real
      // match — this must reach needs_resend, not a silent auto-approve.
      expect(resolveDocumentIntakeOutcome(result, ["req-bank", "req-invoice", "req-payslip"]).kind).toBe("needs_resend");
    });
  });
});

describe("resolveRequirementAssignment — sole-outstanding-requirement fallback", () => {
  it("uses the classifier's match when it found one, ignoring outstanding count", () => {
    const result = resolveRequirementAssignment({ matchedRequirementId: "req-bank", confidence: 0.4 }, ["req-bank", "req-invoice"]);
    expect(result).toEqual({ requirementId: "req-bank", confidence: 0.4 });
  });

  it("auto-assigns to the one outstanding requirement when the AI actually looked at it, confirmed it's legible, but couldn't map it to a specific name (WhatsApp image case)", () => {
    const result = resolveRequirementAssignment(
      { matchedRequirementId: null, confidence: 0, aiRan: true, readabilityIssue: null },
      ["req-id-card"]
    );
    expect(result.requirementId).toBe("req-id-card");
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO_APPROVE_CONFIDENCE);
  });

  it("never auto-assigns when the AI never actually ran (no real file content to check) — a process-of-elimination guess is not identification", () => {
    const result = resolveRequirementAssignment({ matchedRequirementId: null, confidence: 0 }, ["req-id-card"]);
    expect(result).toEqual({ requirementId: null, confidence: 0 });
  });

  it("never auto-assigns when the AI ran but flagged a readability problem — the document must be resent, not silently guessed", () => {
    const result = resolveRequirementAssignment(
      { matchedRequirementId: null, confidence: 0, aiRan: true, readabilityIssue: "blurry" },
      ["req-id-card"]
    );
    expect(result).toEqual({ requirementId: null, confidence: 0 });
  });

  it("stays unmatched when nothing overlaps and more than one requirement is still outstanding", () => {
    const result = resolveRequirementAssignment({ matchedRequirementId: null, confidence: 0 }, ["req-bank", "req-invoice"]);
    expect(result).toEqual({ requirementId: null, confidence: 0 });
  });

  it("stays unmatched when nothing overlaps and zero requirements are outstanding (all already approved)", () => {
    const result = resolveRequirementAssignment({ matchedRequirementId: null, confidence: 0 }, []);
    expect(result).toEqual({ requirementId: null, confidence: 0 });
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
