import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { classifyYesNoReply, classifyFollowUpIntent } = await import("./conversationReplyIntent");

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

describe("classifyYesNoReply", () => {
  it("returns 'no' for a natural-language decline that never leads with a NO_WORD", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { intent: "no", confidence: 0.92 } });

    const result = await classifyYesNoReply("האם שלחת אותו בכוונה?", "זה של אשתי");
    expect(result).toBe("no");
  });

  it("returns 'yes' for a natural-language confirmation", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { intent: "yes", confidence: 0.9 } });

    const result = await classifyYesNoReply("האם שלחת אותו בכוונה?", "כן זה מסמך נוסף שרציתי לצרף");
    expect(result).toBe("yes");
  });

  it("never guesses below the confidence floor — returns 'unclear' even if the model picked a side", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { intent: "yes", confidence: 0.4 } });

    const result = await classifyYesNoReply("האם שלחת אותו בכוונה?", "אולי");
    expect(result).toBe("unclear");
  });

  it("returns 'unclear' on an empty reply without calling the model", async () => {
    const result = await classifyYesNoReply("question", "   ");
    expect(result).toBe("unclear");
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("never throws — a provider failure resolves to 'unclear'", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const result = await classifyYesNoReply("question", "זה של אשתי");
    expect(result).toBe("unclear");
  });
});

describe("classifyFollowUpIntent", () => {
  it("recognizes a send-later promise and estimates a delay", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { isFollowUpPromise: true, approxDelayMinutes: 240 } });

    const result = await classifyFollowUpIntent("אשלח בערב");
    expect(result).toEqual({ isFollowUpPromise: true, approxDelayMinutes: 240 });
  });

  it("returns false for an ordinary message", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { isFollowUpPromise: false, approxDelayMinutes: null } });

    const result = await classifyFollowUpIntent("תודה רבה");
    expect(result).toEqual({ isFollowUpPromise: false, approxDelayMinutes: null });
  });

  it("never throws — a provider failure resolves to no promise recognized", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const result = await classifyFollowUpIntent("אשלח בערב");
    expect(result).toEqual({ isFollowUpPromise: false, approxDelayMinutes: null });
  });

  it("returns false on an empty message without calling the model", async () => {
    const result = await classifyFollowUpIntent("");
    expect(result).toEqual({ isFollowUpPromise: false, approxDelayMinutes: null });
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });
});
