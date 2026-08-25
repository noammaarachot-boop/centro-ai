import { describe, expect, it } from "vitest";
import {
  countRealConversationMessages,
  DELIVERY_STATE_LABEL,
  hasReachedClient,
  resolveMessageDeliveryState,
} from "./messageDeliveryState";

/**
 * Regression — a message row is not a delivered message.
 *
 * Production evidence: 958 outbound rows across all organizations have
 * deliveryStatus "failed" and no WhatsApp id, and three requests were shown
 * as sent to clients who received nothing. One conversation offered
 * "פתיחת השיחה המלאה (114 הודעות)" where all 114 had been refused by the
 * provider.
 */

describe("resolveMessageDeliveryState", () => {
  it("only calls it sent once the provider accepted it", () => {
    expect(resolveMessageDeliveryState("sent")).toBe("sent");
    expect(resolveMessageDeliveryState("delivered")).toBe("delivered");
    expect(resolveMessageDeliveryState("read")).toBe("read");
  });

  it("treats every provider refusal as failed", () => {
    for (const status of ["failed", "stuck", "not_connected", "no_template", "invalid_phone", "blocked"]) {
      expect(resolveMessageDeliveryState(status), status).toBe("failed");
    }
  });

  it("treats a row with no answer yet as pending, never as sent", () => {
    expect(resolveMessageDeliveryState("pending")).toBe("pending");
    expect(resolveMessageDeliveryState(null)).toBe("pending");
    expect(resolveMessageDeliveryState(undefined)).toBe("pending");
  });

  it("never optimistically upgrades an unrecognized status", () => {
    // The whole class of bug was assuming success by default.
    expect(resolveMessageDeliveryState("something-new-from-meta")).toBe("pending");
    expect(hasReachedClient({ direction: "outbound", deliveryStatus: "something-new-from-meta" })).toBe(false);
  });
});

describe("hasReachedClient", () => {
  it("is false for anything the provider has not accepted", () => {
    for (const status of ["pending", "failed", "stuck", "not_connected", "no_template", "invalid_phone", null]) {
      expect(hasReachedClient({ direction: "outbound", deliveryStatus: status }), String(status)).toBe(false);
    }
  });

  it("is true from provider acceptance onward", () => {
    for (const status of ["sent", "delivered", "read"]) {
      expect(hasReachedClient({ direction: "outbound", deliveryStatus: status }), status).toBe(true);
    }
  });

  it("is true for inbound messages, which are with us by definition", () => {
    expect(hasReachedClient({ direction: "inbound", deliveryStatus: null })).toBe(true);
  });
});

describe("countRealConversationMessages", () => {
  it("does not count refused attempts as a conversation", () => {
    // אורי שבתאי's real shape: 114 rows, every one refused.
    const failedAttempts = Array.from({ length: 114 }, () => ({
      direction: "outbound",
      deliveryStatus: "failed",
    }));
    expect(countRealConversationMessages(failedAttempts)).toBe(0);
  });

  it("counts only what the client could actually have seen", () => {
    // רז שלום's real shape: 123 refused, 8 accepted, 1 inbound.
    const thread = [
      ...Array.from({ length: 123 }, () => ({ direction: "outbound", deliveryStatus: "failed" })),
      ...Array.from({ length: 8 }, () => ({ direction: "outbound", deliveryStatus: "sent" })),
      { direction: "inbound", deliveryStatus: null },
    ];
    expect(countRealConversationMessages(thread)).toBe(9);
  });

  it("counts a healthy thread in full", () => {
    const thread = [
      { direction: "outbound", deliveryStatus: "read" },
      { direction: "inbound", deliveryStatus: null },
      { direction: "outbound", deliveryStatus: "delivered" },
    ];
    expect(countRealConversationMessages(thread)).toBe(3);
  });
});

describe("DELIVERY_STATE_LABEL", () => {
  it("never describes an unsent message as sent", () => {
    expect(DELIVERY_STATE_LABEL.failed).toBe("לא נשלחה");
    expect(DELIVERY_STATE_LABEL.pending).toBe("ממתינה לשליחה");
    expect(DELIVERY_STATE_LABEL.pending).not.toContain("נשלחה");
  });

  it("has a distinct label for every state", () => {
    const labels = Object.values(DELIVERY_STATE_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
