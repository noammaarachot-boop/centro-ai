import { describe, expect, it } from "vitest";
import { FREEFORM_WINDOW_MS, isFreeformWindowOpen } from "./conversationOrchestration";

/**
 * Regression — production, 26.8.2026.
 *
 * A reminder failed with Meta's "(#100) Invalid parameter" and the retry
 * failed identically. The cause was this window: WhatsApp accepts free text
 * only within 24h of the client's OWN message, and the client in question
 * had never sent one. The rule used to live only inside a DB query, so the
 * page had no way to know a resend was hopeless before offering it.
 */
const NOW = new Date("2026-08-26T12:00:00Z").getTime();
const at = (msAgo: number, direction: string) => ({ direction, createdAt: new Date(NOW - msAgo) });
const HOUR = 60 * 60 * 1000;

describe("isFreeformWindowOpen", () => {
  it("is CLOSED when the client has never written — the production case", () => {
    expect(isFreeformWindowOpen([at(HOUR, "outbound"), at(2 * HOUR, "outbound")], NOW)).toBe(false);
  });

  it("is closed for an empty conversation", () => {
    expect(isFreeformWindowOpen([], NOW)).toBe(false);
  });

  it("opens on the client's message and closes 24 hours later", () => {
    expect(isFreeformWindowOpen([at(HOUR, "inbound")], NOW)).toBe(true);
    expect(isFreeformWindowOpen([at(23 * HOUR, "inbound")], NOW)).toBe(true);
    expect(isFreeformWindowOpen([at(FREEFORM_WINDOW_MS + 1, "inbound")], NOW)).toBe(false);
  });

  it("is not reopened by our own outbound messages", () => {
    // The bug this guards: conversations.updatedAt is bumped by outbound
    // sends too, so using it would report the window open forever.
    const thread = [at(30 * HOUR, "inbound"), at(HOUR, "outbound")];
    expect(isFreeformWindowOpen(thread, NOW)).toBe(false);
  });

  it("uses the client's MOST RECENT message, whatever order the thread is in", () => {
    const thread = [at(HOUR, "inbound"), at(40 * HOUR, "inbound")];
    expect(isFreeformWindowOpen(thread, NOW)).toBe(true);
    expect(isFreeformWindowOpen([...thread].reverse(), NOW)).toBe(true);
  });
});
