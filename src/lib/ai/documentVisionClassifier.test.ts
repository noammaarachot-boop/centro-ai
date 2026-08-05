import { describe, expect, it, vi } from "vitest";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { classifyDocumentViaVisionAI, isVisionClassifiableMimeType } = await import("./documentVisionClassifier");

const CANDIDATES = [
  { id: "req-id-card", name: "תעודת זהות" },
  { id: "req-license", name: "רישיון נהיגה" },
];

describe("isVisionClassifiableMimeType", () => {
  it("accepts the image/PDF types WhatsApp actually sends", () => {
    expect(isVisionClassifiableMimeType("image/jpeg")).toBe(true);
    expect(isVisionClassifiableMimeType("application/pdf")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isVisionClassifiableMimeType("application/octet-stream")).toBe(false);
  });
});

describe("classifyDocumentViaVisionAI", () => {
  it("returns null without calling the model when there are no candidates", async () => {
    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", []);
    expect(result).toBeNull();
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("returns null for an unsupported mime type without calling the model", async () => {
    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "application/zip", CANDIDATES);
    expect(result).toBeNull();
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("maps a confident model match back to the exact candidate id", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        identified: true,
        documentType: "תעודת זהות",
        identificationConfidence: 0.95,
        matchedRequirementName: "תעודת זהות",
        matchConfidence: 0.92,
      },
    });

    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toEqual({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: "req-id-card",
      matchConfidence: 0.92,
    });
  });

  it("identified but no match — the real 'unsolicited document' case: an invoice sent while only ID-card-style requirements are open", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        identified: true,
        documentType: "חשבונית מס קבלה",
        identificationConfidence: 0.97,
        matchedRequirementName: "לא ידוע / לא תואם",
        matchConfidence: 0,
      },
    });

    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toEqual({
      identified: true,
      documentType: "חשבונית מס קבלה",
      identificationConfidence: 0.97,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
  });

  it("not identified at all — the real 'unrecognized document' case", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        identified: false,
        documentType: null,
        identificationConfidence: 0.1,
        matchedRequirementName: "לא ידוע / לא תואם",
        matchConfidence: 0,
      },
    });

    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result?.identified).toBe(false);
    expect(result?.matchedRequirementId).toBeNull();
  });

  it("never throws — a provider/API failure resolves to null so the caller falls back to unrecognized", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toBeNull();
  });
});
