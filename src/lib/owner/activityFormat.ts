// Turns the raw audit trail into something a human reads as a status
// report rather than a log dump.
//
// Two jobs, both pure so they can be tested without a database:
//   1. Humanize — an event code (whatsapp.send_failed) becomes a sentence
//      ("שליחת הודעת WhatsApp נכשלה"). The code itself is never thrown
//      away; it moves into "פרטים טכניים".
//   2. Aggregate — a run of the same event for the same organization
//      collapses into one line with a count and a time range, so eight
//      identical failures read as "8 פעמים" instead of eight rows.

export interface RawActivityEvent {
  id: string;
  occurredAt: Date;
  eventType: string;
  description: string;
  source: "organization" | "owner";
  organizationName: string | null;
}

export interface AggregatedActivityEvent {
  id: string;
  /** Human sentence — what actually happened, in plain Hebrew. */
  title: string;
  /** How many raw events collapsed into this row (1 when nothing merged). */
  count: number;
  /** Newest occurrence — what "last happened" means for this row. */
  occurredAt: Date;
  /** Oldest occurrence in the run; equal to occurredAt when count is 1. */
  firstOccurredAt: Date;
  eventType: string;
  source: "organization" | "owner";
  organizationName: string | null;
  severity: "info" | "problem";
  /** The raw events behind this row, newest first — shown under "פרטים טכניים". */
  raw: RawActivityEvent[];
}

// Prefix-matched, longest first, so a specific code wins over a family.
// Anything unmatched falls back to the event's own stored description,
// which is already written in Hebrew by every recordAuditEvent call site —
// so an unknown event degrades to "readable", never to a bare code.
const EVENT_LABELS: Array<[string, string]> = [
  ["whatsapp.send_failed", "שליחת הודעת WhatsApp נכשלה"],
  ["whatsapp.send_blocked", "שליחת הודעת WhatsApp נחסמה"],
  ["integration.whatsapp_connected", "חשבון WhatsApp חובר"],
  ["integration.whatsapp_disconnected", "חשבון WhatsApp נותק"],
  ["integration.google_connected", "Google Drive חובר"],
  ["integration.google_disconnected", "Google Drive נותק"],
  ["collection_request.created", "נוצרה בקשת איסוף"],
  ["collection_request.cancelled", "בקשת איסוף בוטלה"],
  ["collection_request.escalated", "בקשת איסוף הועברה לטיפול אנושי"],
  ["collection_request.reopened", "בקשת איסוף נפתחה מחדש"],
  ["collection_request.status_changed", "סטטוס בקשת איסוף עודכן"],
  ["document.uploaded", "מסמך הועלה"],
  ["document.classified", "מסמך סווג"],
  ["document.rejected", "מסמך נדחה"],
  ["pending_confirmation.escalated_no_reply", "הלקוח לא הגיב — הועבר לבדיקת עובד"],
  ["review_item.auto_resolved_by_completion", "פריט בדיקה נסגר אוטומטית — הבקשה הושלמה"],
  ["review_item.auto_resolved_by_cancellation", "פריט בדיקה נסגר אוטומטית — הבקשה בוטלה"],
  ["owner.whatsapp_manually_connected", "WhatsApp חובר ידנית על ידי הבעלים"],
  ["owner.whatsapp_template_submitted", "תבנית WhatsApp הוגשה לאישור Meta"],
  ["owner.whatsapp_template_edited", "תבנית WhatsApp עודכנה מול Meta"],
  ["owner.organization_suspended", "ארגון הושעה"],
  ["owner.organization_reactivated", "ארגון הופעל מחדש"],
];

// Event families that describe something going wrong — surfaced in the
// feed with problem styling so a real fault stands out from routine noise.
const PROBLEM_MARKERS = ["failed", "error", "escalated", "blocked", "rejected", "suspended"];

export function humanizeEventType(eventType: string, fallbackDescription: string): string {
  const match = EVENT_LABELS.find(([code]) => eventType === code);
  if (match) return match[1];
  // Prefix match for a family (e.g. "whatsapp.send_failed.timeout").
  const prefix = EVENT_LABELS.find(([code]) => eventType.startsWith(`${code}.`));
  if (prefix) return prefix[1];
  return fallbackDescription || eventType;
}

export function isProblemEvent(eventType: string): boolean {
  return PROBLEM_MARKERS.some((marker) => eventType.includes(marker));
}

/** Events within this window, of the same type and organization, merge into one row. */
export const AGGREGATION_WINDOW_MS = 15 * 60 * 1000;

// Expects `events` newest-first (which is how listRecentActivity returns
// them). Merges only ADJACENT runs, so an unrelated event in between
// correctly splits two bursts apart rather than silently joining them.
export function aggregateActivity(events: RawActivityEvent[]): AggregatedActivityEvent[] {
  const out: AggregatedActivityEvent[] = [];

  for (const event of events) {
    const last = out[out.length - 1];
    const mergeable =
      last !== undefined &&
      last.eventType === event.eventType &&
      last.organizationName === event.organizationName &&
      last.firstOccurredAt.getTime() - event.occurredAt.getTime() <= AGGREGATION_WINDOW_MS;

    if (mergeable) {
      last.count += 1;
      // Input is newest-first, so each merged event extends the run backwards.
      last.firstOccurredAt = event.occurredAt;
      last.raw.push(event);
      continue;
    }

    out.push({
      id: event.id,
      title: humanizeEventType(event.eventType, event.description),
      count: 1,
      occurredAt: event.occurredAt,
      firstOccurredAt: event.occurredAt,
      eventType: event.eventType,
      source: event.source,
      organizationName: event.organizationName,
      severity: isProblemEvent(event.eventType) ? "problem" : "info",
      raw: [event],
    });
  }

  return out;
}

// "שליחת הודעת WhatsApp נכשלה 8 פעמים" — the count belongs in the
// sentence, not in a separate badge the eye has to reconcile.
export function formatAggregatedTitle(event: AggregatedActivityEvent): string {
  if (event.count === 1) return event.title;
  return `${event.title} ${event.count} פעמים`;
}
