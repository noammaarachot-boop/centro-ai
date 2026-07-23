import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { trimHistoryForContext } from "./contextWindow";

function userMsg(i: number): ModelMessage {
  return { role: "user", content: `message ${i}` };
}
function toolMsg(i: number): ModelMessage {
  return { role: "tool", content: [{ type: "tool-result", toolCallId: `${i}`, toolName: "x", output: { type: "text", value: "y" } }] } as ModelMessage;
}

describe("trimHistoryForContext", () => {
  it("returns everything unchanged when under the limit", () => {
    const messages = Array.from({ length: 10 }, (_, i) => userMsg(i));
    expect(trimHistoryForContext(messages)).toEqual(messages);
  });

  it("trims from the oldest end when over the limit", () => {
    const messages = Array.from({ length: 50 }, (_, i) => userMsg(i));
    const trimmed = trimHistoryForContext(messages);
    expect(trimmed.length).toBeLessThanOrEqual(40);
    expect(trimmed[trimmed.length - 1]).toEqual(userMsg(49));
  });

  it("never starts the trimmed window on a tool message (would orphan a tool-call/tool-result pair)", () => {
    const messages: ModelMessage[] = [
      ...Array.from({ length: 38 }, (_, i) => userMsg(i)),
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "x", input: {} }] } as ModelMessage,
      toolMsg(1),
      userMsg(100),
      userMsg(101),
      userMsg(102),
    ];
    const trimmed = trimHistoryForContext(messages);
    expect(trimmed[0].role).not.toBe("tool");
  });
});
