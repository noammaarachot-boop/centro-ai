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
      object: { documentType: "תעודת זהות", matchedRequirementName: "תעודת זהות", confidence: 0.92 },
    });

    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toEqual({ matchedRequirementId: "req-id-card", confidence: 0.92, documentType: "תעודת זהות" });
  });

  it("returns a null requirement id when the model finds no match", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: { documentType: "קבלה", matchedRequirementName: "לא ידוע / לא תואם", confidence: 0.1 },
    });

    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toEqual({ matchedRequirementId: null, confidence: 0.1, documentType: "קבלה" });
  });

  it("never throws — a provider/API failure resolves to null so the caller falls back to needs_review", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const result = await classifyDocumentViaVisionAI(Buffer.from("x"), "image/jpeg", CANDIDATES);
    expect(result).toBeNull();
  });
});
