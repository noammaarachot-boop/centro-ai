import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();

vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { classifyDeferralIntent } = await import("./deferralIntent");

const REF_DATE = "יום ראשון, 11 בינואר";

function emptyFields() {
  return {
    weekday: null,
    explicitDay: null,
    explicitMonth: null,
    explicitYear: null,
    relativeDays: null,
    relativeWeeks: null,
    namedPeriod: null,
  };
}

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

describe("classifyDeferralIntent", () => {
  it("returns 'not_dated' without calling the model on an empty message", async () => {
    const result = await classifyDeferralIntent("   ", REF_DATE);
    expect(result).toEqual({ kind: "not_dated" });
    expect(resolveLanguageModel).not.toHaveBeenCalled();
  });

  it("maps a 'scheduled' response with relativeDays through to a dateHint", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { kind: "scheduled", ...emptyFields(), relativeDays: 1 } });

    const result = await classifyDeferralIntent("אני יכול לשלוח מחר?", REF_DATE);
    expect(result).toEqual({ kind: "scheduled", dateHint: { ...emptyFields(), relativeDays: 1 } });
  });

  it("maps a 'scheduled' response with a weekday through to a dateHint", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { kind: "scheduled", ...emptyFields(), weekday: "thursday" } });

    const result = await classifyDeferralIntent("אפשר ביום חמישי?", REF_DATE);
    expect(result).toEqual({ kind: "scheduled", dateHint: { ...emptyFields(), weekday: "thursday" } });
  });

  it("degrades 'scheduled' with no extracted field to 'ambiguous' rather than trusting an empty hint", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { kind: "scheduled", ...emptyFields() } });

    const result = await classifyDeferralIntent("אשלח בקרוב", REF_DATE);
    expect(result).toEqual({ kind: "ambiguous" });
  });

  it("passes through 'not_dated' for a vague short-term promise", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { kind: "not_dated", ...emptyFields() } });

    const result = await classifyDeferralIntent("אשלח בערב", REF_DATE);
    expect(result).toEqual({ kind: "not_dated" });
  });

  it("passes through 'ambiguous' for a promise with no computable date", async () => {
    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({ object: { kind: "ambiguous", ...emptyFields() } });

    const result = await classifyDeferralIntent("אשלח כשאחזור", REF_DATE);
    expect(result).toEqual({ kind: "ambiguous" });
  });

  it("never throws — a provider failure resolves to 'not_dated'", async () => {
    resolveLanguageModel.mockRejectedValueOnce(new Error("no provider configured"));
    const result = await classifyDeferralIntent("אשלח ביום חמישי", REF_DATE);
    expect(result).toEqual({ kind: "not_dated" });
  });
});
