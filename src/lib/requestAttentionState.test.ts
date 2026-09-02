import { describe, expect, it } from "vitest";
import {
  REMINDER_QUIET_WINDOW_MS,
  resolveRequestAttentionState,
  type RequestAttentionInput,
} from "./requestAttentionState";
import type { ReviewReason } from "./data/dashboardReadModel";

/**
 * Regression — the attention area must name ONE action that can run.
 *
 * It used to stack independent sentences ("לא ענה", "דורש תשומת לב שלך",
 * "שליחת הודעה נכשלה", "כדאי לבדוק את השיחה למטה") beside a button labelled
 * "הפעלה" — which was a raw state-machine transition to `active`. On a
 * request that was ALREADY active with a failed message it changed nothing
 * while presenting itself as the fix.
 *
 * And regression — this resolver must not DECIDE whether attention exists.
 * It used to measure the client's silence and inspect delivery itself, which
 * meant the request card had a private definition of "דורש טיפול" that the
 * dashboard knew nothing about. Reasons now arrive from
 * getItemsNeedingReview; what is left here is only which action to offer.
 */

const reason = (kind: ReviewReason["kind"], detail = "x"): ReviewReason => ({
  kind,
  detail,
  occurredAt: new Date("2026-01-01T00:00:00Z"),
});

const base: RequestAttentionInput = {
  status: "active",
  reasons: [],
  whatsappReady: true,
  hasConversation: true,
  retryCanSucceed: true,
};

const resolve = (over: Partial<RequestAttentionInput>) => resolveRequestAttentionState({ ...base, ...over });

describe("it reports only what it was given", () => {
  it("no open reason means nothing to say — even on a long-open request", () => {
    // The old version measured age here and could disagree with the
    // dashboard. It cannot any more: with no reason there is no attention.
    expect(resolve({ reasons: [] }).kind).toBe("none");
    expect(resolve({ reasons: [] }).reasons).toEqual([]);
  });

  it("surfaces EVERY reason, not just the one the button addresses", () => {
    const state = resolve({ reasons: [reason("client_overdue"), reason("message_failed")] });

    // A failed send does not stop the client having been silent for days —
    // two different problems, and hiding one leaves the employee without the
    // context for the action they are being asked to take.
    expect(state.reasons).toHaveLength(2);
    expect(state.kind, "the primary reason selects the CTA").toBe("message_failed");
  });
});

describe("A — the last message failed", () => {
  const state = resolve({ reasons: [reason("client_overdue"), reason("message_failed")] });

  it("names retrying the send, not reactivating the request", () => {
    expect(state.kind).toBe("message_failed");
    expect(state.primaryAction?.kind).toBe("retry_send");
    expect(state.primaryAction?.label).toBe("שליחה חוזרת");
  });

  it("keeps the business reason visible above the delivery problem", () => {
    expect(state.reasons.some((r) => r.title.includes("לא השלים"))).toBe(true);
  });

  it("offers a reminder instead when a resend cannot possibly succeed", () => {
    // Free text outside the 24h window is refused identically every time.
    const blocked = resolve({ reasons: [reason("message_failed")], retryCanSucceed: false });
    expect(blocked.primaryAction?.kind).toBe("send_reminder");
  });
});

describe("B — nothing can be sent at all", () => {
  const state = resolve({ reasons: [reason("message_failed")], whatsappReady: false });

  it("offers no send button, because every send would fail the same way", () => {
    expect(state.kind).toBe("not_connected");
    expect(state.primaryAction).toBeNull();
  });

  it("still lets the employee open the conversation", () => {
    expect(state.secondaryAction?.kind).toBe("open_conversation");
  });
});

describe("C — the employee's own queue comes first", () => {
  it("a document awaiting review outranks nudging the client again", () => {
    const state = resolve({ reasons: [reason("client_overdue"), reason("document_needs_review")] });
    expect(state.kind).toBe("needs_review");
    expect(state.primaryAction, "sending on top of unreviewed work is noise").toBeNull();
  });

  it("so does an unanswered client question", () => {
    expect(resolve({ reasons: [reason("employee_question")] }).kind).toBe("needs_review");
  });

  it("and a document the client reported missing", () => {
    expect(resolve({ reasons: [reason("reported_missing")] }).kind).toBe("needs_review");
  });
});

describe("D — the client is simply late", () => {
  it("offers the reminder, which is the one action that helps", () => {
    const state = resolve({ reasons: [reason("client_overdue")] });
    expect(state.kind).toBe("awaiting_client");
    expect(state.primaryAction?.kind).toBe("send_reminder");
  });

  it("does NOT offer another reminder right after one went out", () => {
    const state = resolve({
      reasons: [reason("client_overdue")],
      lastReminderSentAt: new Date(Date.now() - 60_000),
    });
    expect(state.kind).toBe("awaiting_reply");
    expect(state.primaryAction, "one was just sent — asking twice is the bug").toBeNull();
  });

  it("offers one again once the quiet window has passed", () => {
    const state = resolve({
      reasons: [reason("client_overdue")],
      lastReminderSentAt: new Date(Date.now() - REMINDER_QUIET_WINDOW_MS - 1000),
    });
    expect(state.kind).toBe("awaiting_client");
  });

  it("offers one again as soon as the client has answered it", () => {
    const state = resolve({
      reasons: [reason("client_overdue")],
      lastReminderSentAt: new Date(Date.now() - 60_000),
      clientRepliedSinceReminder: true,
    });
    expect(state.kind).toBe("awaiting_client");
  });
});

describe("E — states that answer for themselves", () => {
  it("a draft's missing step is starting it", () => {
    const state = resolve({ status: "draft", reasons: [] });
    expect(state.kind).toBe("paused");
    expect(state.primaryAction?.kind).toBe("reactivate");
  });

  it("a completed request needs nothing, whatever else is true", () => {
    expect(resolve({ status: "completed", reasons: [reason("client_overdue")] }).kind).toBe("none");
  });

  it("a cancelled request needs nothing either", () => {
    expect(resolve({ status: "cancelled", reasons: [reason("message_failed")] }).kind).toBe("none");
  });
});

describe("F — never an action that cannot run", () => {
  it("offers no 'open conversation' when there is no conversation", () => {
    const state = resolve({ reasons: [reason("client_overdue")], hasConversation: false });
    expect(state.secondaryAction).toBeNull();
  });

  it("every reason renders as real sentences, never a raw state name", () => {
    const kinds: ReviewReason["kind"][] = [
      "escalated",
      "client_overdue",
      "message_failed",
      "document_needs_review",
      "employee_question",
      "reported_missing",
    ];
    for (const kind of kinds) {
      const [rendered] = resolve({ reasons: [reason(kind, "פרט")] }).reasons;
      expect(rendered.title, kind).toBeTruthy();
      expect(rendered.title, kind).not.toContain("_");
      expect(rendered.detail, kind).toBeTruthy();
    }
  });
});
