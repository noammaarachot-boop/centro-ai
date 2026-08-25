import { describe, expect, it } from "vitest";
import { filterUserFacingActivity, isUserFacingActivityEvent } from "./activityHistory";

// This filter decides what an employee sees on a request's timeline. Two
// properties matter: it must never hide a real business event, and it must
// not repeat what the conversation thread already shows.

const event = (eventType: string) => ({ eventType, id: eventType, description: "x" });

describe("keeps the events a user actually cares about", () => {
  it("keeps request lifecycle events", () => {
    for (const type of [
      "collection_request.created",
      "collection_request.cancelled",
      "collection_request.escalated",
      "collection_request.status_changed",
      "collection_request.requirement_waived",
      "collection_request.reopened",
    ]) {
      expect(isUserFacingActivityEvent(type), type).toBe(true);
    }
  });

  it("keeps document events", () => {
    for (const type of [
      "document.received",
      "document.approved",
      "document.rejected",
      "document.reviewed",
      "document.added_manually",
      "document.unreadable",
      "document.duplicate_detected",
    ]) {
      expect(isUserFacingActivityEvent(type), type).toBe(true);
    }
  });

  it("keeps conversation handoff events", () => {
    for (const type of [
      "conversation.initiated",
      "conversation.human_takeover",
      "conversation.human_control_released",
      "conversation.reminder_deferred",
    ]) {
      expect(isUserFacingActivityEvent(type), type).toBe(true);
    }
  });

  // The most important rows on the timeline: a send that never arrived is
  // invisible in the conversation, so hiding it here would hide it entirely.
  it("keeps delivery FAILURES even though it hides successes", () => {
    expect(isUserFacingActivityEvent("whatsapp.send_failed")).toBe(true);
    expect(isUserFacingActivityEvent("whatsapp.send_blocked")).toBe(true);
    expect(isUserFacingActivityEvent("whatsapp.outbound_send_failed")).toBe(true);
    expect(isUserFacingActivityEvent("scheduler.reminder_send_failed")).toBe(true);
  });

  it("keeps reminders that were actually sent or deferred", () => {
    expect(isUserFacingActivityEvent("scheduler.reminder_sent")).toBe(true);
    expect(isUserFacingActivityEvent("scheduler.reminder_deferred_outside_hours")).toBe(true);
  });

  // Denylist, not allowlist: an unknown/new event type must show up rather
  // than be silently swallowed.
  it("keeps an event type it has never seen before", () => {
    expect(isUserFacingActivityEvent("something.brand_new")).toBe(true);
  });
});

describe("hides internal engine chatter", () => {
  it("hides AI classification and reasoning steps", () => {
    for (const type of [
      "message.conversation_intent_classified",
      "message.conversation_reasoning_outcome",
      "message.correction_intent_classified",
      "document.classified",
      "document.ad_hoc_type_observed",
      "policy.matched_and_answered",
    ]) {
      expect(isUserFacingActivityEvent(type), type).toBe(false);
    }
  });

  it("hides scheduler bookkeeping while keeping its outcomes", () => {
    expect(isUserFacingActivityEvent("scheduler.evaluation_prompted")).toBe(false);
    expect(isUserFacingActivityEvent("scheduler.case_status_review_run")).toBe(false);
    // The outcome of a tick is still shown.
    expect(isUserFacingActivityEvent("scheduler.reminder_sent")).toBe(true);
  });
});

describe("does not repeat the conversation", () => {
  // Every outbound message records whatsapp.send_completed. Showing that
  // next to the message itself is the same fact twice, and it crowded out
  // the entries that were actually worth reading.
  it("hides the per-message 'sent' row", () => {
    expect(isUserFacingActivityEvent("whatsapp.send_completed")).toBe(false);
  });
});

describe("filterUserFacingActivity", () => {
  it("removes only the hidden types and preserves order", () => {
    const filtered = filterUserFacingActivity([
      event("collection_request.created"),
      event("whatsapp.send_completed"),
      event("document.received"),
      event("message.conversation_intent_classified"),
      event("whatsapp.send_failed"),
    ]);

    expect(filtered.map((e) => e.eventType)).toEqual([
      "collection_request.created",
      "document.received",
      "whatsapp.send_failed",
    ]);
  });

  it("returns an empty list unchanged", () => {
    expect(filterUserFacingActivity([])).toEqual([]);
  });
});
