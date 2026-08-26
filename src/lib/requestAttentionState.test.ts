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
  retryCanSucceed: true,
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

  it("takes the CTA — the client cannot act on a message that never arrived", () => {
    // It decides the ACTION. It must not decide what the employee is told:
    // an earlier version returned a single state here, which silently
    // deleted the fact that this client had been overdue for three days.
    expect(state.primaryAction?.kind).toBe("retry_send");
    expect(state.reasons.map((r) => r.title)).toContain("ההודעה האחרונה לא נשלחה");
    expect(state.reasons.map((r) => r.title)).toContain("הלקוח לא הגיב לבקשה");
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
    expect(state.reasons[0].detail).toContain("4");
  });

  it("distinguishes a client who replied from one who never did", () => {
    expect(resolve({ unsatisfiedCount: 2, daysOpen: 4, clientHasReplied: true }).reasons[0].title).toContain("לא השלים");
    expect(resolve({ unsatisfiedCount: 2, daysOpen: 4, clientHasReplied: false }).reasons[0].title).toContain("לא הגיב");
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
    expect(state.reasons.some((r) => r.title.includes("2"))).toBe(true);
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
      expect(state.reasons.length, state.kind).toBeGreaterThan(0);
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

/**
 * Regression — two problems at once, and neither one hidden.
 *
 * Reported from production: a request was three days overdue AND its last
 * message had failed to send. The panel showed only the failure, so the
 * employee was handed a "שליחה חוזרת" button with no indication of why the
 * request mattered — and once the resend succeeded the panel went quiet,
 * as though the client had supplied the documents.
 *
 * A delivery problem and a business problem are independent. One may take
 * the CTA; it may not erase the other.
 */
describe("combined states", () => {
  const overdue = { unsatisfiedCount: 2, daysOpen: 4 };
  const titles = (over: Partial<RequestAttentionInput>) => resolve(over).reasons.map((r) => r.title);

  it("1 — overdue, delivery fine: one reason, and a reminder", () => {
    const state = resolve({ ...overdue, lastOutboundDeliveryStatus: "delivered" });
    expect(state.kind).toBe("awaiting_client");
    expect(state.primaryAction?.kind).toBe("send_reminder");
    expect(state.reasons).toHaveLength(1);
    expect(state.reasons[0].detail).toContain("4");
  });

  it("2 — send failed, not yet overdue: one reason, and no invented deadline", () => {
    const state = resolve({ lastOutboundDeliveryStatus: "failed", unsatisfiedCount: 2, daysOpen: 1 });
    expect(state.kind).toBe("message_failed");
    expect(state.reasons).toHaveLength(1);
    expect(titles({ lastOutboundDeliveryStatus: "failed", unsatisfiedCount: 2, daysOpen: 1 })).not.toContain(
      "הלקוח לא הגיב לבקשה"
    );
  });

  it("3 — overdue AND send failed: BOTH reasons, one CTA", () => {
    const state = resolve({ ...overdue, lastOutboundDeliveryStatus: "failed" });
    expect(state.reasons).toHaveLength(2);
    expect(state.reasons.map((r) => r.title)).toEqual([
      "הלקוח לא הגיב לבקשה",
      "ההודעה האחרונה לא נשלחה",
    ]);
    // One button, and it addresses the thing that blocks the other.
    expect(state.primaryAction?.kind).toBe("retry_send");
    expect(state.guidance.length).toBeGreaterThan(0);
  });

  it("4 — the resend succeeded: the delivery reason goes, the business reason STAYS", () => {
    // This is the same request as (3) after a successful retry. If the
    // panel fell silent here it would be claiming the client had finished.
    const after = resolve({ ...overdue, lastOutboundDeliveryStatus: "sent" });
    expect(after.kind).toBe("awaiting_client");
    expect(after.reasons.map((r) => r.title)).toEqual(["הלקוח לא הגיב לבקשה"]);
    expect(after.primaryAction?.kind).toBe("send_reminder");
  });

  it("5 — the resend failed again: still both reasons, still one retry", () => {
    const again = resolve({ ...overdue, lastOutboundDeliveryStatus: "failed" });
    expect(again.kind).toBe("message_failed");
    expect(again.reasons).toHaveLength(2);
    expect(again.primaryAction?.kind).toBe("retry_send");
  });

  it("6 — a request that was never started says so, and nothing else", () => {
    const state = resolve({ ...overdue, status: "draft", lastOutboundDeliveryStatus: "failed" });
    expect(state.kind).toBe("paused");
    expect(state.reasons).toHaveLength(1);
    expect(state.primaryAction?.kind).toBe("reactivate");
  });

  it("7 — WhatsApp disconnected: reasons still shown, but NO button that would refail", () => {
    const state = resolve({ ...overdue, lastOutboundDeliveryStatus: "failed", whatsappReady: false });
    expect(state.kind).toBe("not_connected");
    expect(state.reasons, "the employee still needs to know why it matters").toHaveLength(2);
    expect(state.primaryAction, "retrying cannot succeed while disconnected").toBeNull();
  });

  it("8 — completed: no stale attention UI, whatever else is true", () => {
    const state = resolve({ ...overdue, status: "completed", lastOutboundDeliveryStatus: "failed", reviewItemCount: 3 });
    expect(state.kind).toBe("none");
    expect(state.reasons).toEqual([]);
    expect(state.primaryAction).toBeNull();
    expect(state.secondaryAction).toBeNull();
  });

  it("9 — cancelled: no CTA offering to chase a request nobody wants", () => {
    const state = resolve({ ...overdue, status: "cancelled", lastOutboundDeliveryStatus: "failed" });
    expect(state.kind).toBe("none");
    expect(state.primaryAction).toBeNull();
  });

  it("never shows a reason without a plain-language detail, or any internal name", () => {
    const jargon = ["message_failed", "awaiting_client", "not_connected", "needs_review", "failed", "state", "#100"];
    const all = [
      resolve({ ...overdue, lastOutboundDeliveryStatus: "failed" }),
      resolve({ ...overdue, whatsappReady: false }),
      resolve({ ...overdue, reviewItemCount: 2 }),
      resolve({ status: "draft" }),
      resolve(overdue),
    ];
    for (const state of all) {
      for (const reason of state.reasons) {
        expect(reason.title.length).toBeGreaterThan(0);
        expect(reason.detail.length).toBeGreaterThan(0);
      }
      const text = [state.guidance, ...state.reasons.flatMap((r) => [r.title, r.detail])].join(" ");
      for (const word of jargon) expect(text, word).not.toContain(word);
    }
  });
});

/**
 * Regression — production, 26.8.2026.
 *
 * A reminder to a client who had NEVER written in failed with Meta's
 * "(#100) Invalid parameter", the panel offered "שליחה חוזרת", the employee
 * pressed it, and it failed again for exactly the same reason: free text is
 * only accepted inside the 24-hour window a client message opens, and that
 * window had never once been open on this conversation.
 *
 * A button whose only possible outcome is the same failure is not an action.
 */
describe("a resend that cannot work is not offered", () => {
  const failed = { lastOutboundDeliveryStatus: "failed", unsatisfiedCount: 2, daysOpen: 4 };

  it("offers an approved reminder instead, and says why", () => {
    const state = resolve({ ...failed, retryCanSucceed: false });
    expect(state.kind).toBe("message_failed");
    expect(state.primaryAction?.kind, "another identical attempt would refail").not.toBe("retry_send");
    expect(state.primaryAction?.kind).toBe("send_reminder");
    expect(state.guidance).toContain("מאושרת");
  });

  it("still reports BOTH problems — the client is late whether or not we can resend", () => {
    expect(resolve({ ...failed, retryCanSucceed: false }).reasons).toHaveLength(2);
  });

  it("does offer the resend when the send can actually go out", () => {
    expect(resolve({ ...failed, retryCanSucceed: true }).primaryAction?.kind).toBe("retry_send");
  });
});
