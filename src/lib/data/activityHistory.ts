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

export const ACTIVITY_CATEGORIES = [
  "all",
  "request",
  "document",
  "whatsapp",
  "template",
  "team",
  "failure",
] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  all: "הכל",
  request: "בקשות",
  document: "מסמכים",
  whatsapp: "WhatsApp",
  template: "תבניות",
  team: "צוות",
  failure: "תקלות",
};

interface ActivityRow {
  eventType: string;
  description: string;
  actorType: string;
  metadata: unknown;
}

interface ActivityLabel {
  title: string;
  detail?: string;
}

interface EventDefinition {
  category: Exclude<ActivityCategory, "all">;
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
  if (to === "completed") return { title: "בקשת האיסוף הושלמה" };
  if (to === "cancelled") return { title: "בקשת האיסוף בוטלה" };
  if (to === "processing") return { title: "הבקשה עברה לבדיקה" };
  if (to === "active" && from === "escalated") return { title: "בקשת האיסוף נשלחה מחדש ללקוח" };
  return null;
}

function documentReviewLabel(row: ActivityRow): ActivityLabel {
  // reviewDocument's own description already reads "מסמך ... סומן כאושר/נדחה/דורש בדיקה על ידי עובד"
  return reuseDescription(row);
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
const BUSINESS_EVENT_DEFINITIONS: Record<string, EventDefinition> = {
  // --- בקשות ---
  "collection_request.created": { category: "request", label: reuseDescription },
  "collection_request.scheduled_send_delivered": { category: "request", label: reuseDescription },
  "collection_request.status_changed": { category: "request", label: collectionRequestStatusLabel },
  "collection_request.escalated": {
    category: "request",
    label: (row) => ({ title: "הבקשה הועברה לטיפול ידני", detail: row.description || undefined }),
  },
  "collection_request.reopened": { category: "request", label: reuseDescription },
  "collection_request.reopened_via_correction": { category: "request", label: reuseDescription },
  "collection_request.requirement_waived": { category: "request", label: reuseDescription },
  "collection_request.extension_finished_confirmed": { category: "request", label: reuseDescription },
  "collection_request.auto_created": { category: "request", label: reuseDescription },
  "requirement.exception_reported": { category: "request", label: reuseDescription },
  "requirement.exception_waived": { category: "request", label: reuseDescription },
  "requirement.exception_alternative_requested": { category: "request", label: reuseDescription },
  "requirement.exception_contact_client": { category: "request", label: reuseDescription },

  // --- מסמכים ---
  "document.received": { category: "document", label: reuseDescription },
  "document.added_manually": { category: "document", label: reuseDescription },
  "document.reviewed": { category: "document", label: documentReviewLabel },
  "document.rejected_unsupported_type": { category: "document", label: reuseDescription },
  "document.unreadable": { category: "document", label: reuseDescription },
  "document.duplicate_detected": { category: "document", label: reuseDescription },
  "document.identity_anomaly_confirmed": { category: "document", label: reuseDescription },
  "document.identity_anomaly_rejected": { category: "document", label: reuseDescription },
  "document.unsolicited_approved": { category: "document", label: reuseDescription },
  "document.unsolicited_rejected": { category: "document", label: reuseDescription },
  "document.requirement_assigned": { category: "document", label: reuseDescription },
  "document.superseded": { category: "document", label: reuseDescription },

  // --- WhatsApp (business-meaningful sends only — never the full transcript) ---
  "conversation.initiated": { category: "whatsapp", label: reuseDescription },
  "scheduler.reminder_sent": {
    category: "whatsapp",
    label: () => ({ title: "נשלחה תזכורת ללקוח" }),
  },
  "review_item.resolved": {
    category: "whatsapp",
    label: (row) => ({ title: "העובד השיב ללקוח", detail: row.description }),
  },

  // --- תבניות ---
  "template.created": { category: "template", label: templateCreatedLabel },
  "template.updated": { category: "template", label: templateUpdatedLabel },
  "template.deleted": { category: "template", label: reuseDescription },
  "template.duplicated": { category: "template", label: templateDuplicatedLabel },
  "template.requirement_added": { category: "template", label: reuseDescription },
  "template.requirement_removed": { category: "template", label: reuseDescription },
  "template.requirement_renamed": { category: "template", label: reuseDescription },
  "template.clients_assigned": { category: "template", label: reuseDescription },
  "template.client_removed": { category: "template", label: reuseDescription },

  // --- צוות ---
  "employee.registered": { category: "team", label: reuseDescription },
  "conversation.human_takeover": { category: "team", label: reuseDescription },
  "conversation.human_control_released": { category: "team", label: reuseDescription },
  "review_item.opened": {
    category: "team",
    label: (row) => ({ title: "התקבלה שאלה מהלקוח הממתינה לתשובת עובד", detail: row.description }),
  },

  // --- תקלות ---
  "whatsapp.send_failed": { category: "failure", label: () => ({ title: "שליחת הודעת WhatsApp נכשלה" }) },
  "whatsapp.outbound_send_failed": { category: "failure", label: reuseDescription },
  "whatsapp.send_blocked": { category: "failure", label: reuseDescription },
  "whatsapp.inbound_media_download_failed": {
    category: "failure",
    label: () => ({ title: "הורדת קובץ שנשלח בוואטסאפ נכשלה" }),
  },
  "whatsapp.inbound_processing_failed": {
    category: "failure",
    label: () => ({ title: "עיבוד מסמך שהתקבל בוואטסאפ נכשל" }),
  },
  "document.drive_upload_exhausted": { category: "failure", label: reuseDescription },
  "document.drive_upload_skipped": { category: "failure", label: reuseDescription },
  "document.merge_failed": { category: "failure", label: () => ({ title: "מיזוג עמודי מסמך נכשל" }) },
  "integration.google_token_refresh_failed": {
    category: "failure",
    label: () => ({ title: "חידוש החיבור ל-Google Drive נכשל" }),
  },
  "pending_confirmation.escalated_no_reply": { category: "failure", label: reuseDescription },
};

export interface ActivityItem {
  id: string;
  category: Exclude<ActivityCategory, "all">;
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
    [item.clientName, item.templateName, item.requestLabel, item.title]
      .filter((v): v is string => !!v)
      .some((v) => v.toLowerCase().includes(needle))
  );
}
