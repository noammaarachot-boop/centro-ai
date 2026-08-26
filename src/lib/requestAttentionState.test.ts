import { describe, expect, it } from "vitest";
import { resolveRequestAttentionState, type RequestAttentionInput } from "./requestAttentionState";

/**
 * Regression — the attention area must name ONE action that can run.
 *
 * It used to stack independent sentences ("לא ענה", "דורש תשומת לב שלך",
 * "שליחת הודעה נכשלה", "כדאי לבדוק את השיחה למטה") beside a button labelled
 * "הפעלה" — which was a raw state-machine transition to `active`. On a
 * request that was ALREADY active with a failed message it changed nothing
 * while presenting itself as the fix.
 */

const base: RequestAttentionInput = {
  status: "active",
  lastOutboundDeliveryStatus: "delivered",
  clientHasReplied: false,
  unsatisfiedCount: 0,
  reviewItemCount: 0,
  whatsappReady: true,
  hasConversation: true,
  daysOpen: 0,
};

const resolve = (over: Partial<RequestAttentionInput>) => resolveRequestAttentionState({ ...base, ...over });

describe("A — the last message failed", () => {
  const state = resolve({ lastOutboundDeliveryStatus: "failed", unsatisfiedCount: 2, daysOpen: 3 });

  it("names retrying the send, not reactivating the request", () => {
    expect(state.kind).toBe("message_failed");
    expect(state.primaryAction?.kind).toBe("retry_send");
    expect(state.primaryAction?.label).toBe("שליחה חוזרת");
  });

  it("outranks 'the client has not replied' — they had nothing to reply to", () => {
    expect(state.title).toContain("לא נשלחה");
    expect(state.title).not.toContain("לא הגיב");
  });

  it("offers the conversation as a secondary way in", () => {
    expect(state.secondaryAction?.kind).toBe("open_conversation");
  });

  it("treats every provider refusal the same way", () => {
    for (const status of ["failed", "not_connected", "no_template", "invalid_phone", "stuck"]) {
      expect(resolve({ lastOutboundDeliveryStatus: status }).kind, status).toBe("message_failed");
    }
  });
});

describe("B — delivered, but the client has not finished", () => {
  const state = resolve({ lastOutboundDeliveryStatus: "delivered", unsatisfiedCount: 2, daysOpen: 4 });

  it("offers a reminder rather than a resend", () => {
    expect(state.kind).toBe("awaiting_client");
    expect(state.primaryAction?.kind).toBe("send_reminder");
    expect(state.primaryAction?.label).toBe("שליחת תזכורת עכשיו");
  });

  it("says how long it has been", () => {
    expect(state.title).toContain("4");
  });

  it("distinguishes a client who replied from one who never did", () => {
    expect(resolve({ unsatisfiedCount: 2, daysOpen: 4, clientHasReplied: true }).title).toContain("טרם השלים");
    expect(resolve({ unsatisfiedCount: 2, daysOpen: 4, clientHasReplied: false }).title).toContain("לא הגיב");
  });

  it("stays quiet before the request is actually overdue", () => {
    expect(resolve({ unsatisfiedCount: 2, daysOpen: 1 }).kind).toBe("none");
  });
});

describe("C — the request was never sent", () => {
  it("offers to start it, and says that sending is what will happen", () => {
    const state = resolve({ status: "draft" });
    expect(state.kind).toBe("paused");
    expect(state.primaryAction?.kind).toBe("reactivate");
    expect(state.primaryAction?.label).toContain("שליחה");
  });
});

describe("D — nothing can be done automatically", () => {
  it("offers NO primary button when WhatsApp is not connected", () => {
    const state = resolve({ whatsappReady: false, lastOutboundDeliveryStatus: "failed", daysOpen: 5 });
    expect(state.kind).toBe("not_connected");
    expect(state.primaryAction, "a button that cannot work must not be shown").toBeNull();
    expect(state.guidance).toContain("הגדרות");
  });

  it("offers no send when the work is the employee's own queue", () => {
    const state = resolve({ reviewItemCount: 2, unsatisfiedCount: 1, daysOpen: 5 });
    expect(state.kind).toBe("needs_review");
    expect(state.primaryAction).toBeNull();
    expect(state.title).toContain("2");
  });

  it("omits the conversation link when there is no conversation", () => {
    expect(resolve({ whatsappReady: false, hasConversation: false }).secondaryAction).toBeNull();
  });
});

describe("quiet states", () => {
  it("says nothing for a completed or cancelled request", () => {
    for (const status of ["completed", "cancelled"]) {
      const state = resolve({ status, lastOutboundDeliveryStatus: "failed", unsatisfiedCount: 3, daysOpen: 9 });
      expect(state.kind, status).toBe("none");
      expect(state.primaryAction, status).toBeNull();
    }
  });

  it("says nothing when the request is simply progressing", () => {
    expect(resolve({ unsatisfiedCount: 0, daysOpen: 1 }).kind).toBe("none");
  });
});

describe("the shape the UI depends on", () => {
  it("every actionable state has exactly one primary action and both sentences", () => {
    const actionable = [
      resolve({ lastOutboundDeliveryStatus: "failed" }),
      resolve({ unsatisfiedCount: 1, daysOpen: 5 }),
      resolve({ status: "draft" }),
    ];
    for (const state of actionable) {
      expect(state.title.length, state.kind).toBeGreaterThan(0);
      expect(state.guidance.length, state.kind).toBeGreaterThan(0);
      expect(state.primaryAction, state.kind).not.toBeNull();
    }
  });

  it("never produces the old ambiguous label", () => {
    const all = [
      resolve({ lastOutboundDeliveryStatus: "failed" }),
      resolve({ unsatisfiedCount: 1, daysOpen: 5 }),
      resolve({ status: "draft" }),
      resolve({ whatsappReady: false }),
      resolve({ reviewItemCount: 1, unsatisfiedCount: 1, daysOpen: 5 }),
    ];
    for (const state of all) {
      expect(state.primaryAction?.label ?? "").not.toBe("הפעלה");
    }
  });
});
