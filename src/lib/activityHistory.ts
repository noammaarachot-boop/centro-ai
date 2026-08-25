/**
 * Which audit events belong in the user-facing "היסטוריית פעילות" timeline.
 *
 * DISPLAY LAYER ONLY. Nothing here deletes, rewrites, or stops recording
 * anything — every event still lands in audit_logs exactly as before, and
 * the full trail stays available for support and compliance. This decides
 * only what an employee is shown on a request screen.
 *
 * A denylist, not an allowlist, and that choice is deliberate. An allowlist
 * would silently swallow any new event type someone adds later — a log that
 * quietly omits real activity is worse than one that occasionally shows a
 * row we would rather have hidden. This fails toward showing too much,
 * which is visible and easy to correct.
 */

/**
 * Internal engine chatter: real records, but they describe how the system
 * reached a decision rather than anything that happened to the request.
 * None of them mean anything to the person reading the screen.
 */
const INTERNAL_EVENT_TYPES = new Set<string>([
  // AI classification/reasoning steps.
  "message.conversation_intent_classified",
  "message.conversation_reasoning_outcome",
  "message.correction_intent_classified",
  "document.classified",
  "document.ad_hoc_type_observed",
  "client.business_type_classified",
  "clients.classified",
  "policy.matched_and_answered",

  // Scheduler bookkeeping — the tick ran and looked at this request. The
  // outcome (a reminder sent, an escalation) is recorded separately and is
  // what actually matters.
  "scheduler.evaluation_prompted",
  "scheduler.case_status_review_run",

  // Internal state upkeep with no business meaning on its own.
  "document.drive_upload_skipped",
  "review_item.context_updated",
]);

/**
 * Events whose content the conversation thread already shows.
 *
 * The separation this file exists to enforce: the conversation is what was
 * SAID to the client; the timeline is what HAPPENED to the request. A row
 * reading "an outbound message was sent" next to the message itself is the
 * same fact twice, and it pushed the genuinely interesting entries out of
 * view.
 *
 * Note this covers successful sends only. A send that FAILED or was BLOCKED
 * is never visible in the thread — there is no message to look at — so it
 * stays in the timeline, where it is often the most important row on it.
 */
const DUPLICATES_CONVERSATION = new Set<string>(["whatsapp.send_completed"]);

export interface ActivityEvent {
  id: string;
  eventType: string;
  description: string;
  occurredAt: Date | string;
}

/** True when this event should be shown to an employee. */
export function isUserFacingActivityEvent(eventType: string): boolean {
  return !INTERNAL_EVENT_TYPES.has(eventType) && !DUPLICATES_CONVERSATION.has(eventType);
}

export function filterUserFacingActivity<T extends { eventType: string }>(events: T[]): T[] {
  return events.filter((event) => isUserFacingActivityEvent(event.eventType));
}
