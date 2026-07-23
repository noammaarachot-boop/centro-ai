import { describe, expect, it } from "vitest";
import { toJsonSafe } from "./jsonSafe";

// Regression test for a real AI_InvalidPromptError found via live browser
// testing: every src/lib/data/* function returns raw Drizzle rows with
// real Date objects for timestamp columns, and a Date instance fails the
// provider SDK's own message-array validation on any agent-loop step
// after the first.
describe("toJsonSafe", () => {
  it("converts nested Date instances to ISO strings", () => {
    const input = { id: "1", createdAt: new Date("2026-07-23T10:00:00.000Z") };
    const result = toJsonSafe(input);
    expect(result.createdAt).toBe("2026-07-23T10:00:00.000Z");
    expect(typeof result.createdAt).toBe("string");
  });

  it("converts Date instances inside arrays", () => {
    const input = [{ createdAt: new Date("2026-01-01T00:00:00.000Z") }];
    const result = toJsonSafe(input);
    expect(result[0].createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("leaves already-plain values unchanged", () => {
    const input = { id: "1", name: "לקוח בדיקה", count: 3, active: true, missing: null };
    expect(toJsonSafe(input)).toEqual(input);
  });
});
