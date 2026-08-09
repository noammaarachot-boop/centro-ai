import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CorrectionContext } from "./correctionContext";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { classifyCorrectionIntent } = await import("./correctionClassifier");

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

const emptyContext: CorrectionContext = {
  collectionRequestId: "req-1",
  conversationId: "conv-1",
  requirementFacts: [],
  openQuestion: null,
  recentDocuments: [],
  recentResolvedConfirmations: [],
  recentMessages: [],
};

describe("classifyCorrectionIntent", () => {
  it("empty text -> not_applicable without calling the model", async () => {
    const result = await classifyCorrectionIntent(emptyContext, "");
    expect(result.kind).toBe("not_applicable");
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("nothing open and nothing recent -> not_applicable without calling the model", async () => {
    const result = await classifyCorrectionIntent(emptyContext, "שלחתי בטעות");
    expect(result.kind).toBe("not_applicable");
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("a document candidate present -> calls the model, returns its correction classification", async () => {
    const context: CorrectionContext = {
      ...emptyContext,
      recentDocuments: [
        {
          id: "doc-1",
          documentType: "תעודת זהות",
          requirementName: null,
          extractedPersonName: "דוד כהן",
          extractedCompanyName: null,
          status: "identity_anomaly_confirmed",
          receivedAt: new Date().toISOString(),
        },
      ],
    };
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        kind: "corrects_resolved",
        confidence: 0.95,
        answer: null,
        targetType: "document",
        targetId: "doc-1",
        desiredOutcome: "mark_withdrawn",
      },
    });
    const result = await classifyCorrectionIntent(context, "שלחתי בטעות");
    expect(result).toEqual({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: "doc-1",
      desiredOutcome: "mark_withdrawn",
    });
  });

  it("an open question present -> can classify as answers_open_question", async () => {
    const context: CorrectionContext = {
      ...emptyContext,
      openQuestion: { id: "pc-1", kind: "identity_anomaly", question: "האם הוא נשלח במקום תעודת הזהות של רז שלום?" },
    };
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        kind: "answers_open_question",
        confidence: 0.9,
        answer: "confirm",
        targetType: null,
        targetId: null,
        desiredOutcome: null,
      },
    });
    const result = await classifyCorrectionIntent(context, "טעיתי, דווקא כן");
    expect(result.kind).toBe("answers_open_question");
    expect(result.answer).toBe("confirm");
  });

  it("a provider failure falls back to not_applicable — never guesses", async () => {
    const context: CorrectionContext = {
      ...emptyContext,
      openQuestion: { id: "pc-1", kind: "identity_anomaly", question: "..." },
    };
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider"));
    const result = await classifyCorrectionIntent(context, "משהו");
    expect(result.kind).toBe("not_applicable");
  });
});
