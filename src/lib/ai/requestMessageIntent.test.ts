import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { classifyRequestMessageIntent } = await import("./requestMessageIntent");

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

describe("classifyRequestMessageIntent", () => {
  it("empty text -> unrelated without calling the model", async () => {
    const result = await classifyRequestMessageIntent("", []);
    expect(result).toEqual({ category: "unrelated", mentionedDocumentType: null });
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("'איזה תלושים אני צריך לשלוח?' classifies as request_overview", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { category: "request_overview", mentionedDocumentType: null } });
    const result = await classifyRequestMessageIntent("איזה תלושים אני צריך לשלוח?", ["תלוש שכר"]);
    expect(result.category).toBe("request_overview");
  });

  it("'אין לי את אישור השכירות' classifies as no_document_exception with the mentioned type", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: { category: "no_document_exception", mentionedDocumentType: "אישור שכירות" },
    });
    const result = await classifyRequestMessageIntent("אין לי את אישור השכירות", ["אישור שכירות"]);
    expect(result).toEqual({ category: "no_document_exception", mentionedDocumentType: "אישור שכירות" });
  });

  it("a provider failure falls back to unrelated — stays silent, never guesses", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider"));
    const result = await classifyRequestMessageIntent("בוקר טוב", []);
    expect(result).toEqual({ category: "unrelated", mentionedDocumentType: null });
  });
});
