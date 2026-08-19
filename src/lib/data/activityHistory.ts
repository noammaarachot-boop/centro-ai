import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, clients, collectionRequests, services, users } from "@/db/schema";

// The Activity History screen's own read layer — a curated, human-facing
// VIEW over the real audit_logs table, never a second logging mechanism.
// audit_logs itself is untouched: every technical/internal event keeps
// being written exactly as before (correction layer, AI classification,
// scheduler bookkeeping, webhook processing) for compliance/debugging via
// direct DB access — this file only decides which of those rows, and in
// what words, a non-technical office user should ever see on this screen.
//
// Design: an explicit allowlist (BUSINESS_EVENT_DEFINITIONS below), keyed
// by the real eventType strings already in use across the codebase (never
// invented). Anything not in the allowlist is silently excluded from this
// view — not deleted, not hidden from any other consumer (the per-request
// page's own full audit history, /collections/[id], is untouched and still
// shows everything). Each definition's label() function may return null
// for a specific row to skip it conditionally (e.g. a generic status-change
// event whose target status isn't business-meaningful on its own).

// "team"/multi-user is deliberately not a category — Centro is single-user
// per account today (no team/multi-user concept exists anywhere else in
// the product), so a filter for it would be UI for a feature that isn't
// real yet. Every event still carries and displays its real actor
// (actorName/actorType below) for audit-trail correctness and to stay
// future-proof — only the "team" grouping/filter itself is absent.
export const ACTIVITY_CATEGORIES = ["all", "request", "document", "whatsapp", "template", "failure"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  all: "הכל",
  request: "בקשות",
  document: "מסמכים",
  whatsapp: "WhatsApp",
  template: "תבניות",
  failure: "תקלות",
};

// Visual weight only — never affects which events are shown or how
// they're filtered/searched. "critical" (failures) and "significant"
// (a request completing/escalating, a document rejected/flagged as an
// exception) earn more visual attention; "routine" everyday housekeeping
// (a document received, a template edited) stays visually quiet so it
// doesn't compete for attention with what actually needs it.
export type ActivityEmphasis = "routine" | "significant" | "critical";

interface ActivityRow {
  eventType: string;
  description: string;
  actorType: string;
  metadata: unknown;
}

interface ActivityLabel {
  title: string;
  detail?: string;
  emphasis?: ActivityEmphasis;
}

interface EventDefinition {
  category: Exclude<ActivityCategory, "all">;
  // Default emphasis for this event type when label() doesn't override it
  // per-row (most events have one fixed emphasis; collection_request.status_changed
  // is the one case where it genuinely depends on which status was reached).
  emphasis: ActivityEmphasis;
  // Returns null to skip this specific occurrence (not the whole event
  // type) — used only where the same eventType covers both business-
  // meaningful and purely-internal transitions (collection_request.status_changed).
  label: (row: ActivityRow) => ActivityLabel | null;
}

function statusChangeMetadata(row: ActivityRow): { from?: string; to?: string } {
  const m = row.metadata as { from?: string; to?: string } | null;
  return m ?? {};
}

// Reuses the description text verbatim — already written as a clear
// Hebrew sentence at the point the event was recorded (see each real
// recordAuditEvent call site). The alternative (re-deriving a label from
// metadata alone) would be reinventing text that's already correct.
function reuseDescription(row: ActivityRow): ActivityLabel {
  return { title: row.description };
}

// collection_request.status_changed carries every transition the state
// machine allows (see collectionRequestStateMachine.ts's ALLOWED_TRANSITIONS)
// in one generic eventType, with the raw enum values embedded in its own
// description ("סטטוס בקשת האיסוף עודכן מ-processing ל-completed") — exactly
// the state-machine terminology this screen must never surface. Only the
// subset with real business meaning gets a clean label here; every other
// target status (e.g. active -> waiting_for_client, an internal signal)
// returns null and is skipped.
function collectionRequestStatusLabel(row: ActivityRow): ActivityLabel | null {
  const { from, to } = statusChangeMetadata(row);
  if (to === "completed") return { title: "בקשת האיסוף הושלמה", emphasis: "significant" };
  if (to === "cancelled") return { title: "בקשת האיסוף בוטלה", emphasis: "significant" };
  if (to === "processing") return { title: "הבקשה עברה לבדיקה", emphasis: "routine" };
  if (to === "active" && from === "escalated") return { title: "בקשת האיסוף נשלחה מחדש ללקוח", emphasis: "routine" };
  return null;
}

// reviewDocument's own description already reads "מסמך ... סומן כאושר/נדחה/דורש
// בדיקה על ידי עובד" — reused verbatim, but a rejection earns the stronger
// "significant" tier (needs the client to act again) while an approval
// stays routine.
function documentReviewLabel(row: ActivityRow): ActivityLabel {
  const emphasis: ActivityEmphasis = row.description.includes("נדחה") ? "significant" : "routine";
  return { title: row.description, emphasis };
}

// template.created/template.updated's own stored description text says
// "בקשת האיסוף ... נוצרה/עודכנה" — a leftover naming mix-up from before
// Templates and Collection Requests were split into distinct concepts
// (see templates/actions.ts's own header comment). Reusing it verbatim
// here would reintroduce exactly the confusing terminology this screen
// exists to remove, so these three get a fresh label instead of reuse.
function templateCreatedLabel(row: ActivityRow): ActivityLabel {
  const name = row.description.match(/"([^"]+)"/)?.[1];
  return { title: name ? `התבנית "${name}" נוצרה` : "תבנית חדשה נוצרה" };
}
function templateUpdatedLabel(row: ActivityRow): ActivityLabel {
  const name = row.description.match(/"([^"]+)"/)?.[1];
  return { title: name ? `פרטי התבנית "${name}" עודכנו` : "פרטי תבנית עודכנו" };
}
function templateDuplicatedLabel(row: ActivityRow): ActivityLabel {
  const match = row.description.match(/"([^"]+)"\s*שוכפלה\s*ל"([^"]+)"/);
  return {
    title: match ? `התבנית "${match[1]}" שוכפלה ל"${match[2]}"` : "תבנית שוכפלה",
  };
}

// The one allowlist — every key is a real eventType found in use across
// the codebase (see the audit skill this task's own report documents).
// Never invented. Anything not listed here never appears on this screen.
// No "team" category (see ACTIVITY_CATEGORIES' own comment) — employee.registered
// is the one event that was purely about team/multi-user and is dropped
// from this view entirely (still written to audit_logs, just not shown
// here); conversation.human_takeover/human_control_released and
// review_item.opened are real request/client activity regardless of who's
// single-user today, so they're reassigned to "request"/"whatsapp" rather
// than removed — every one of them already carries a real actor, still
// shown per-item below.
const BUSINESS_EVENT_DEFINITIONS: Record<string, EventDefinition> = {
  // --- בקשות ---
  "collection_request.created": { category: "request", emphasis: "routine", label: reuseDescription },
  "collection_request.scheduled_send_delivered": { category: "request", emphasis: "routine", label: reuseDescription },
  "collection_request.status_changed": { category: "request", emphasis: "routine", label: collectionRequestStatusLabel },
  "collection_request.escalated": {
    category: "request",
    emphasis: "significant",
    label: (row) => ({ title: "הבקשה הועברה לטיפול ידני", detail: row.description || undefined, emphasis: "significant" }),
  },
  "collection_request.reopened": { category: "request", emphasis: "significant", label: reuseDescription },
  "collection_request.reopened_via_correction": { category: "request", emphasis: "significant", label: reuseDescription },
  "collection_request.requirement_waived": { category: "request", emphasis: "routine", label: reuseDescription },
  "collection_request.extension_finished_confirmed": { category: "request", emphasis: "routine", label: reuseDescription },
  "collection_request.auto_created": { category: "request", emphasis: "routine", label: reuseDescription },
  "requirement.exception_reported": { category: "request", emphasis: "significant", label: reuseDescription },
  "requirement.exception_waived": { category: "request", emphasis: "routine", label: reuseDescription },
  "requirement.exception_alternative_requested": { category: "request", emphasis: "routine", label: reuseDescription },
  "requirement.exception_contact_client": { category: "request", emphasis: "significant", label: reuseDescription },
  "conversation.human_takeover": { category: "request", emphasis: "significant", label: reuseDescription },
  "conversation.human_control_released": { category: "request", emphasis: "routine", label: reuseDescription },

  // --- מסמכים ---
  "document.received": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.added_manually": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.reviewed": { category: "document", emphasis: "routine", label: documentReviewLabel },
  "document.rejected_unsupported_type": { category: "document", emphasis: "significant", label: reuseDescription },
  "document.unreadable": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.duplicate_detected": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.identity_anomaly_confirmed": { category: "document", emphasis: "significant", label: reuseDescription },
  "document.identity_anomaly_rejected": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.unsolicited_approved": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.unsolicited_rejected": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.requirement_assigned": { category: "document", emphasis: "routine", label: reuseDescription },
  "document.superseded": { category: "document", emphasis: "routine", label: reuseDescription },

  // --- WhatsApp (business-meaningful sends only — never the full transcript) ---
  "conversation.initiated": { category: "whatsapp", emphasis: "routine", label: reuseDescription },
  "scheduler.reminder_sent": {
    category: "whatsapp",
    emphasis: "routine",
    label: () => ({ title: "נשלחה תזכורת ללקוח" }),
  },
  "review_item.resolved": {
    category: "whatsapp",
    emphasis: "routine",
    label: (row) => ({ title: "העובד השיב ללקוח", detail: row.description }),
  },
  "review_item.opened": {
    category: "whatsapp",
    emphasis: "significant",
    label: (row) => ({ title: "התקבלה שאלה מהלקוח הממתינה לתשובת עובד", detail: row.description, emphasis: "significant" }),
  },

  // --- תבניות ---
  "template.created": { category: "template", emphasis: "routine", label: templateCreatedLabel },
  "template.updated": { category: "template", emphasis: "routine", label: templateUpdatedLabel },
  "template.deleted": { category: "template", emphasis: "routine", label: reuseDescription },
  "template.duplicated": { category: "template", emphasis: "routine", label: templateDuplicatedLabel },
  "template.requirement_added": { category: "template", emphasis: "routine", label: reuseDescription },
  "template.requirement_removed": { category: "template", emphasis: "routine", label: reuseDescription },
  "template.requirement_renamed": { category: "template", emphasis: "routine", label: reuseDescription },
  "template.clients_assigned": { category: "template", emphasis: "routine", label: reuseDescription },
  "template.client_removed": { category: "template", emphasis: "routine", label: reuseDescription },

  // --- תקלות ---
  "whatsapp.send_failed": { category: "failure", emphasis: "critical", label: () => ({ title: "שליחת הודעת WhatsApp נכשלה" }) },
  "whatsapp.outbound_send_failed": { category: "failure", emphasis: "critical", label: reuseDescription },
  "whatsapp.send_blocked": { category: "failure", emphasis: "significant", label: reuseDescription },
  "whatsapp.inbound_media_download_failed": {
    category: "failure",
    emphasis: "critical",
    label: () => ({ title: "הורדת קובץ שנשלח בוואטסאפ נכשלה" }),
  },
  "whatsapp.inbound_processing_failed": {
    category: "failure",
    emphasis: "critical",
    label: () => ({ title: "עיבוד מסמך שהתקבל בוואטסאפ נכשל" }),
  },
  "document.drive_upload_exhausted": { category: "failure", emphasis: "critical", label: reuseDescription },
  "document.drive_upload_skipped": { category: "failure", emphasis: "significant", label: reuseDescription },
  "document.merge_failed": { category: "failure", emphasis: "critical", label: () => ({ title: "מיזוג עמודי מסמך נכשל" }) },
  "integration.google_token_refresh_failed": {
    category: "failure",
    emphasis: "critical",
    label: () => ({ title: "חידוש החיבור ל-Google Drive נכשל" }),
  },
  "pending_confirmation.escalated_no_reply": { category: "failure", emphasis: "significant", label: reuseDescription },
};

export interface ActivityItem {
  id: string;
  category: Exclude<ActivityCategory, "all">;
  emphasis: ActivityEmphasis;
  title: string;
  detail?: string;
  occurredAt: Date;
  actorType: string;
  actorName: string | null;
  clientId: string | null;
  clientName: string | null;
  collectionRequestId: string | null;
  requestLabel: string | null;
  templateId: string | null;
  templateName: string | null;
  // Only present for the "failure" category — raw technical context
  // (description/metadata), shown only behind an explicit "הצג פרטים"
  // toggle, never by default.
  technicalDetail: string | null;
}

export interface ActivityHistoryFilters {
  from?: Date;
  to?: Date;
  category?: ActivityCategory;
  // Free-text match against client name, template name, or the request's
  // own service/period label — never against raw eventType/description
  // internals.
  search?: string;
}

function extractTemplateId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).templateId;
  return typeof value === "string" ? value : null;
}

// The one place raw audit_logs rows become what this screen renders.
// Never mutates or deletes anything — a pure read + filter + relabel.
export async function listActivityHistory(
  organizationId: string,
  filters: ActivityHistoryFilters = {},
  limit = 300
): Promise<ActivityItem[]> {
  const db = await getDb();
  const conditions = [eq(auditLogs.organizationId, organizationId)];
  if (filters.from) conditions.push(gte(auditLogs.occurredAt, filters.from));
  if (filters.to) conditions.push(lte(auditLogs.occurredAt, filters.to));

  const allowedEventTypes = Object.keys(BUSINESS_EVENT_DEFINITIONS);
  conditions.push(inArray(auditLogs.eventType, allowedEventTypes));

  const rows = await db
    .select({
      id: auditLogs.id,
      occurredAt: auditLogs.occurredAt,
      eventType: auditLogs.eventType,
      actorType: auditLogs.actorType,
      description: auditLogs.description,
      metadata: auditLogs.metadata,
      clientId: auditLogs.clientId,
      clientName: clients.name,
      collectionRequestId: auditLogs.collectionRequestId,
      requestPeriodLabel: collectionRequests.periodLabel,
      requestTemplateName: services.name,
      actorFullName: users.fullName,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(clients, eq(auditLogs.clientId, clients.id))
    .leftJoin(collectionRequests, eq(auditLogs.collectionRequestId, collectionRequests.id))
    .leftJoin(services, eq(collectionRequests.serviceId, services.id))
    .leftJoin(users, eq(auditLogs.actorUserId, users.id))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.occurredAt))
    .limit(limit);

  // Template-scoped events (template.created/deleted/etc.) have no
  // collectionRequestId to join through — their template context, when
  // present, lives in metadata.templateId (see templates/actions.ts).
  // Batched here rather than per-row to avoid an N+1 query; the template
  // row is never deleted (soft-delete only, services.retiredAt), so this
  // resolves correctly even for a since-retired template.
  const templateIds = [...new Set(rows.map((r) => extractTemplateId(r.metadata)).filter((id): id is string => !!id))];
  const templateNameById = new Map<string, string>();
  if (templateIds.length > 0) {
    const templateRows = await db.select({ id: services.id, name: services.name }).from(services).where(inArray(services.id, templateIds));
    for (const t of templateRows) templateNameById.set(t.id, t.name);
  }

  const items: ActivityItem[] = [];
  for (const row of rows) {
    const definition = BUSINESS_EVENT_DEFINITIONS[row.eventType];
    if (!definition) continue; // defensive — inArray above already scopes to known keys
    const label = definition.label(row);
    if (!label) continue;

    const templateId = extractTemplateId(row.metadata);
    const requestLabel =
      row.requestTemplateName && row.requestPeriodLabel ? `${row.requestTemplateName} · ${row.requestPeriodLabel}` : null;

    items.push({
      id: row.id,
      category: definition.category,
      emphasis: label.emphasis ?? definition.emphasis,
      title: label.title,
      detail: label.detail,
      occurredAt: row.occurredAt,
      actorType: row.actorType,
      actorName: row.actorFullName ?? row.actorEmail,
      clientId: row.clientId,
      clientName: row.clientName,
      collectionRequestId: row.collectionRequestId,
      requestLabel,
      templateId,
      templateName: templateId ? (templateNameById.get(templateId) ?? null) : row.requestTemplateName,
      technicalDetail: definition.category === "failure" ? row.description : null,
    });
  }

  const categoryFiltered =
    !filters.category || filters.category === "all" ? items : items.filter((item) => item.category === filters.category);

  if (!filters.search?.trim()) return categoryFiltered;
  const needle = filters.search.trim().toLowerCase();
  return categoryFiltered.filter((item) =>
    // Names first (what a person actually types), but also the raw ids —
    // pasting a collectionRequestId/clientId/templateId (e.g. from a URL
    // or another screen) must find its own events too.
    [
      item.clientName,
      item.templateName,
      item.requestLabel,
      item.title,
      item.clientId,
      item.collectionRequestId,
      item.templateId,
    ]
      .filter((v): v is string => !!v)
      .some((v) => v.toLowerCase().includes(needle))
  );
}

// --- Visual grouping (display-layer only — never touches audit_logs) ---

export interface ActivityGroup {
  // The representative item shown collapsed — always the newest of the
  // group (items arrive newest-first).
  item: ActivityItem;
  // Every real item in the group, oldest-last (same order as the input),
  // including `item` itself — "הצג N פעולות" reveals exactly these, never
  // a re-fetch or a re-derived summary.
  items: ActivityItem[];
}

// Two events with the exact same title, in the exact same category,
// occurring within this window of each other are treated as "the same
// kind of thing happening in a burst" (e.g. the real production case this
// screen was built against: 10 identically-named templates deleted one
// after another in under a minute) — collapsed to one visual row with a
// count and an expandable list of the real underlying items. Never a
// server-side dedup: every item is still returned by listActivityHistory
// and still fully present in `items` below; this only decides how the
// already-fetched list is grouped for display.
const GROUPING_WINDOW_MS = 5 * 60 * 1000;

export function groupActivityItems(items: ActivityItem[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const item of items) {
    const lastGroup = groups[groups.length - 1];
    const lastItem = lastGroup?.items[lastGroup.items.length - 1];
    const withinWindow =
      lastItem && Math.abs(lastItem.occurredAt.getTime() - item.occurredAt.getTime()) <= GROUPING_WINDOW_MS;
    if (lastGroup && lastItem && withinWindow && lastItem.title === item.title && lastItem.category === item.category) {
      lastGroup.items.push(item);
    } else {
      groups.push({ item, items: [item] });
    }
  }
  return groups;
}
