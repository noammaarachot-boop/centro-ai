import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovedPolicy } from "./policyKnowledgeBase";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
const generateText = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  generateText: (...args: unknown[]) => generateText(...args),
}));

const { matchClientQuestionToPolicy, renderPolicyAnswer } = await import("./policyKnowledgeBase");

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
  generateText.mockReset();
});

function makePolicy(overrides: Partial<ApprovedPolicy>): ApprovedPolicy {
  return {
    id: "policy-1",
    organizationId: "org-1",
    questionSummary: "אפשר לשלוח דרכון במקום תעודת זהות?",
    decisionText: "כן, דרכון תקף מתקבל כתחליף לתעודת זהות.",
    relatedDocumentType: "תעודת זהות",
    category: "alternative_or_policy_question",
    isActive: true,
    sourceReviewItemId: null,
    createdByUserId: null,
    createdAt: new Date(),
    retiredAt: null,
    retiredByUserId: null,
    ...overrides,
  };
}

describe("matchClientQuestionToPolicy", () => {
  it("empty question or no candidates -> no match, no AI call", async () => {
    expect(await matchClientQuestionToPolicy("", [makePolicy({})])).toEqual({ policyId: null, confidence: 0 });
    expect(resolveLanguageModel).not.toHaveBeenCalled();
    expect(await matchClientQuestionToPolicy("שאלה", [])).toEqual({ policyId: null, confidence: 0 });
  });

  it("matches by MEANING despite completely different wording", async () => {
    const policy = makePolicy({ id: "policy-1", questionSummary: "אפשר לשלוח דרכון במקום תעודת זהות?" });
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { matchedPolicyId: "policy-1", confidence: 0.9 } });

    // Deliberately worded nothing like the stored policy.
    const result = await matchClientQuestionToPolicy("היי, אין לי תעודת זהות איתי, יש לי רק את הדרכון הישן שלי, זה בסדר?", [policy]);
    expect(result).toEqual({ policyId: "policy-1", confidence: 0.9 });
  });

  it("low confidence -> null, even if the model named an id", async () => {
    const policy = makePolicy({ id: "policy-1" });
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { matchedPolicyId: "policy-1", confidence: 0.4 } });

    const result = await matchClientQuestionToPolicy("שאלה מעורפלת", [policy]);
    expect(result.policyId).toBeNull();
  });

  it("a hallucinated id not in the candidate list is never trusted", async () => {
    const policy = makePolicy({ id: "policy-1" });
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { matchedPolicyId: "policy-does-not-exist", confidence: 0.95 } });

    const result = await matchClientQuestionToPolicy("שאלה כלשהי", [policy]);
    expect(result).toEqual({ policyId: null, confidence: 0 });
  });

  it("no matching policy exists -> null, never guesses", async () => {
    const policy = makePolicy({ id: "policy-1", questionSummary: "אפשר לשלוח דרכון במקום תעודת זהות?" });
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { matchedPolicyId: null, confidence: 0 } });

    const result = await matchClientQuestionToPolicy("האם המסמך עדיין בתוקף אחרי 5 שנים?", [policy]);
    expect(result.policyId).toBeNull();
  });

  it("a provider failure falls back to no match, never crashes", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider"));
    const result = await matchClientQuestionToPolicy("שאלה", [makePolicy({})]);
    expect(result).toEqual({ policyId: null, confidence: 0 });
  });
});

describe("renderPolicyAnswer", () => {
  it("phrases the policy's own decision text naturally for the client", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateText.mockResolvedValueOnce({ text: "כן, אפשר לשלוח דרכון תקף במקום תעודת הזהות." });
    const answer = await renderPolicyAnswer("יש לי רק דרכון, זה בסדר?", { decisionText: "כן, דרכון תקף מתקבל.", questionSummary: "..." });
    expect(answer).toContain("דרכון");
  });

  it("falls back to the raw decision text on AI failure — never silent", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider"));
    const answer = await renderPolicyAnswer("שאלה", { decisionText: "כן, זה בסדר.", questionSummary: "..." });
    expect(answer).toBe("כן, זה בסדר.");
  });
});
