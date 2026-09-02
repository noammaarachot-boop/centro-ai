import { describe, expect, it } from "vitest";
import { resolveDisplayStatus } from "./requestDisplayStatus";

/**
 * Regression — one request, two contradictory labels.
 *
 * A card showed a green "פעיל" at the top while carrying "דורש טיפול" inside
 * it: both were technically true (the request was active AND had an open
 * attention item) but "פעיל" reads as "all is well", so the two lines
 * contradicted each other.
 *
 * The database keeps lifecycle and attention as separate facts, and that
 * separation stays — merging them back into one column is the bug this
 * project just removed. They are combined only here, once, for display.
 */
describe("resolveDisplayStatus", () => {
  it("active with nothing pending reads as 'בתהליך'", () => {
    // Not "פעיל": in a document-collection context a reader takes that to
    // mean "fine", when it only ever meant "running".
    expect(resolveDisplayStatus({ status: "active" }).label).toBe("בתהליך");
  });

  it("waiting on the client with nothing pending reads as 'ממתין ללקוח'", () => {
    expect(resolveDisplayStatus({ status: "waiting_for_client" }).label).toBe("ממתין ללקוח");
  });

  it("an open attention outranks 'active' — the reported contradiction", () => {
    expect(resolveDisplayStatus({ status: "active", hasOpenAttention: true }).label).toBe("דורש טיפול");
  });

  it("an open attention outranks 'waiting_for_client' too", () => {
    expect(resolveDisplayStatus({ status: "waiting_for_client", hasOpenAttention: true }).label).toBe(
      "דורש טיפול"
    );
  });

  it("once the attention is handled, the lifecycle speaks again", () => {
    // The same request before and after the employee presses "טופל". The
    // lifecycle value never changed; only the attention did.
    expect(resolveDisplayStatus({ status: "waiting_for_client", hasOpenAttention: true }).label).toBe(
      "דורש טיפול"
    );
    expect(resolveDisplayStatus({ status: "waiting_for_client", hasOpenAttention: false }).label).toBe(
      "ממתין ללקוח"
    );
  });

  it("completed reads as 'הושלם'", () => {
    expect(resolveDisplayStatus({ status: "completed" }).label).toBe("הושלם");
  });

  it("cancelled reads as 'בוטל'", () => {
    expect(resolveDisplayStatus({ status: "cancelled" }).label).toBe("בוטל");
  });

  it("a finished request is finished, whatever else is true", () => {
    // A stale attention item must never make a completed request look open.
    expect(resolveDisplayStatus({ status: "completed", hasOpenAttention: true }).label).toBe("הושלם");
    expect(resolveDisplayStatus({ status: "cancelled", hasOpenAttention: true }).label).toBe("בוטל");
  });

  it("the escalated lifecycle value still reads as 'דורש טיפול'", () => {
    // It IS an attention state by definition, so it must not fall through to
    // "בתהליך" just because no separate attention flag was passed.
    expect(resolveDisplayStatus({ status: "escalated" }).label).toBe("דורש טיפול");
  });

  it("a draft is never 'דורש טיפול' — nothing is in flight to act on", () => {
    expect(resolveDisplayStatus({ status: "draft", hasOpenAttention: true }).label).toBe("טיוטה");
  });

  it("never says 'פעיל' or 'הוסלם' in any combination", () => {
    const statuses = [
      "draft",
      "active",
      "waiting_for_client",
      "processing",
      "completed",
      "escalated",
      "cancelled",
    ] as const;
    for (const status of statuses) {
      for (const hasOpenAttention of [true, false]) {
        const { label } = resolveDisplayStatus({ status, hasOpenAttention });
        expect(label, `${status}/${hasOpenAttention}`).not.toBe("פעיל");
        expect(label, `${status}/${hasOpenAttention}`).not.toBe("הוסלם");
        expect(label.length, `${status}/${hasOpenAttention}`).toBeGreaterThan(0);
      }
    }
  });

  it("gives one label per state — no surface can disagree with another", () => {
    // Two screens rendering the same request must get identical output for
    // identical input; that is the whole point of resolving in one place.
    const a = resolveDisplayStatus({ status: "active", hasOpenAttention: true });
    const b = resolveDisplayStatus({ status: "active", hasOpenAttention: true });
    expect(a).toEqual(b);
  });
});
