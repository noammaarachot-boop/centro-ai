import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, services } from "@/db/schema";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { captureError } from "@/lib/monitoring/errorReporting";
import {
  ACTIVE_REQUEST_STATUSES,
  computeRequirementsProgress,
  getActiveRequestsCount,
  getCompletedThisWeekCount,
  getItemsNeedingReview,
  getLastActivityAtByRequest,
  type NeedsReviewItem,
  type ReviewReasonKind,
} from "@/lib/data/dashboardReadModel";
import { hasSentAnyOnDemandRequest, resolveOnDemandDraft } from "@/lib/data/collectionRequestDrafts";

// The one composition layer between dashboardReadModel.ts (the real
// engine's own numbers) and OneTimeDashboard.tsx (pure rendering). Every
// decision about WHAT is true (is this request waiting on the client? Is
// it done? Does it need review?) already happened in dashboardReadModel.ts
// / the state machine — this file only shapes those already-decided facts
// into copy and view props. It never re-derives a status or a count on its
// own.

// A request the operator can currently act on through /collections/[id] —
// the same real per-request page that already hosts document review and
// the conversation thread, so every action link below points there rather
// than inventing a separate workflow.
const IN_PROGRESS_STATUSES: CollectionRequestStatus[] = [
  "active",
  "waiting_for_client",
  "processing",
  "escalated",
];

// Foregrounds exactly one reason per needs-review item for the priority
// list row — most urgent first. A request with several simultaneous
// reasons still only takes one row (see getItemsNeedingReview's own
// dedup); this only picks which of its reasons is shown there.
const REASON_PRIORITY: ReviewReasonKind[] = [
  "escalated",
  "employee_question",
  "document_needs_review",
  "reported_missing",
];

function pickPrimaryReason(item: NeedsReviewItem) {
  for (const kind of REASON_PRIORITY) {
    const reason = item.reasons.find((r) => r.kind === kind);
    if (reason) return reason;
  }
  return item.reasons[0];
}

const REASON_COPY: Record<
  ReviewReasonKind,
  {
    severity: "danger" | "warning";
    title: (clientName: string) => string;
    meta: (detail: string) => string;
    actionLabel: string;
    chipLabel: (count: number) => string;
    subtextPhrase: (count: number) => string;
  }
> = {
  escalated: {
    severity: "danger",
    title: (clientName) => `${clientName} — הבקשה באיחור`,
    meta: (detail) => detail || "הבקשה עברה את חלון הטיפול הרגיל.",
    actionLabel: "לפתיחת הבקשה",
    chipLabel: (count) => (count === 1 ? "בקשה באיחור" : "בקשות באיחור"),
    subtextPhrase: (count) => (count === 1 ? "בקשה אחת באיחור" : `${count} בקשות באיחור`),
  },
  employee_question: {
    severity: "warning",
    title: (clientName) => `${clientName} — מחכה לתשובה ממך`,
    meta: (detail) => `"${detail}"`,
    actionLabel: "לצפייה בשיחה",
    chipLabel: (count) => (count === 1 ? "שאלה ממתינה לתשובה" : "שאלות ממתינות לתשובה"),
    subtextPhrase: (count) => (count === 1 ? "שאלה אחת מחכה לתשובה שלך" : `${count} שאלות מחכות לתשובה שלך`),
  },
  document_needs_review: {
    severity: "warning",
    title: (clientName) => `${clientName} — צריך לבדוק מסמך`,
    meta: (detail) => `המסמך "${detail}" ממתין לבדיקה שלך`,
    actionLabel: "לבדיקת המסמך",
    chipLabel: (count) => (count === 1 ? "מסמך לבדיקה" : "מסמכים לבדיקה"),
    subtextPhrase: (count) => (count === 1 ? "מסמך אחד מחכה לבדיקה שלך" : `${count} מסמכים מחכים לבדיקה שלך`),
  },
  reported_missing: {
    severity: "warning",
    title: (clientName) => `${clientName} — דיווח על מסמך חסר`,
    meta: (detail) => `"${detail}"`,
    actionLabel: "לטיפול בבקשה",
    chipLabel: (count) => (count === 1 ? "דיווח על מסמך חסר" : "דיווחים על מסמכים חסרים"),
    subtextPhrase: (count) => (count === 1 ? "דיווח אחד על מסמך חסר" : `${count} דיווחים על מסמכים חסרים`),
  },
};

export interface NeedsAttentionRow {
  collectionRequestId: string;
  severity: "danger" | "warning";
  title: string;
  meta: string;
  actionHref: string;
  actionLabel: string;
}

export interface InProgressRow {
  collectionRequestId: string;
  clientName: string;
  serviceName: string;
  periodLabel: string;
  satisfiedCount: number;
  totalCount: number;
  status: CollectionRequestStatus;
  lastActivityLabel: string;
  href: string;
}

export interface HeroChip {
  label: string;
  count: number;
  tone: "danger" | "warning";
  /**
   * Where this chip actually goes.
   *
   * Every chip used to link to /collections — the generic list — so
   * clicking "בקשה באיחור" showed everything except the one request that
   * raised the alert. A chip standing for exactly one request now opens
   * that request; several open the review queue filtered to their reason,
   * which is the closest thing to "these ones".
   */
  href: string;
}

export interface OneTimeDashboardView {
  hasSentAnyRequest: boolean;
  draftId: string | null;
  kpis: {
    needsReviewCount: number;
    activeRequestsCount: number;
    completedThisWeekCount: number;
  };
  hero: {
    state: "attention" | "calm";
    headline: string;
    subtext: string;
    chips: HeroChip[];
  };
  needsAttention: NeedsAttentionRow[];
  inProgress: InProgressRow[];
}

async function loadRequestSummaries(collectionRequestIds: string[]) {
  const map = new Map<
    string,
    { clientName: string; serviceName: string; periodLabel: string; status: CollectionRequestStatus }
  >();
  if (collectionRequestIds.length === 0) return map;

  const db = await getDb();
  const rows = await db
    .select({
      id: collectionRequests.id,
      clientName: clients.name,
      serviceName: services.name,
      periodLabel: collectionRequests.periodLabel,
      status: collectionRequests.status,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(inArray(collectionRequests.id, collectionRequestIds));

  for (const row of rows) {
    map.set(row.id, {
      clientName: row.clientName,
      serviceName: row.serviceName,
      periodLabel: row.periodLabel,
      status: row.status,
    });
  }
  return map;
}

// A collectionRequestId that reached this view (from getItemsNeedingReview
// or the in-progress query) but has no matching client/service summary is
// a broken reference — the request row itself, or its client/service, went
// missing between the two reads (or worse, a real data-integrity gap).
// There's no safe real value to show in its place (a placeholder name
// would be invented business data), so the row is dropped from what's
// rendered — but never silently. Same observability path scheduler.ts's
// own "stuck pending message" anomaly uses.
function reportMissingRequestSummary(
  organizationId: string,
  collectionRequestId: string,
  context: "needsAttention" | "inProgress"
) {
  console.error(
    "[oneTimeDashboardView] collectionRequestId has no matching client/service summary — dropped from dashboard view",
    { organizationId, collectionRequestId, context }
  );
  captureError(new Error("Dashboard read model: missing collection request summary"), {
    organizationId,
    collectionRequestId,
    context,
  });
}

function buildHero(items: NeedsReviewItem[]): OneTimeDashboardView["hero"] {
  if (items.length === 0) {
    return {
      state: "calm",
      headline: "הכול בשליטה",
      subtext: "אין דבר שדורש את תשומת לבך כרגע.",
      chips: [],
    };
  }

  const countByKind = new Map<ReviewReasonKind, number>();
  for (const item of items) {
    const kind = pickPrimaryReason(item).kind;
    countByKind.set(kind, (countByKind.get(kind) ?? 0) + 1);
  }

  const chips: HeroChip[] = [];
  const phrases: string[] = [];
  for (const kind of REASON_PRIORITY) {
    const count = countByKind.get(kind);
    if (!count) continue;
    const copy = REASON_COPY[kind];
    // One item: go straight to it. Several: the review queue for that
    // reason. Never the undifferentiated list.
    const matching = items.filter((item) => pickPrimaryReason(item).kind === kind);
    const href =
      matching.length === 1 && matching[0].collectionRequestId
        ? `/collections/${matching[0].collectionRequestId}`
        : `/dashboard?kpi=needs_review&reason=${encodeURIComponent(kind)}`;
    chips.push({ label: copy.chipLabel(count), count, tone: copy.severity, href });
    phrases.push(copy.subtextPhrase(count));
  }

  const subtext =
    phrases.length <= 1
      ? `${phrases[0] ?? ""}.`
      : `${phrases.slice(0, -1).join(", ")} ו${phrases[phrases.length - 1]}.`;

  return {
    state: "attention",
    headline: items.length === 1 ? "דבר אחד מחכה לטיפול שלך" : `${items.length} דברים מחכים לטיפול שלך`,
    subtext,
    chips,
  };
}

// Shared row-builder for every "list of requests" view this file
// produces (the homepage's capped in-progress table, and the KPI
// drill-down pages below) — one place that turns a set of
// collectionRequestIds into fully-detailed InProgressRow objects, so a
// drill-down list is never a second, differently-shaped rendering of the
// same underlying data.
async function buildRequestRows(organizationId: string, ids: string[]): Promise<InProgressRow[]> {
  if (ids.length === 0) return [];
  const [summaries, lastActivityByRequest] = await Promise.all([
    loadRequestSummaries(ids),
    getLastActivityAtByRequest(ids),
  ]);

  return (
    await Promise.all(
      ids.map(async (id) => {
        const summary = summaries.get(id);
        if (!summary) {
          reportMissingRequestSummary(organizationId, id, "inProgress");
          return null;
        }
        const progress = await computeRequirementsProgress(id);
        const lastActivity = lastActivityByRequest.get(id) ?? null;
        return {
          collectionRequestId: id,
          clientName: summary.clientName,
          serviceName: summary.serviceName,
          periodLabel: summary.periodLabel,
          satisfiedCount: progress.satisfiedCount,
          totalCount: progress.totalCount,
          status: summary.status,
          lastActivityLabel: lastActivity ? formatRelativeTime(lastActivity) : "—",
          href: `/collections/${id}`,
        };
      })
    )
  ).filter((row): row is InProgressRow => row !== null);
}

// Shared row-builder for the "needs attention" shape — used both by the
// homepage's own section and the KPI drill-down page below, so the two
// never drift into differently-worded/ordered views of the same
// getItemsNeedingReview() items.
async function buildNeedsAttentionRows(organizationId: string, needsReviewItems: NeedsReviewItem[]): Promise<NeedsAttentionRow[]> {
  const ids = needsReviewItems.map((item) => item.collectionRequestId);
  const summaries = await loadRequestSummaries(ids);

  return needsReviewItems
    .map((item) => {
      const summary = summaries.get(item.collectionRequestId);
      if (!summary) {
        reportMissingRequestSummary(organizationId, item.collectionRequestId, "needsAttention");
        return null;
      }
      const reason = pickPrimaryReason(item);
      const copy = REASON_COPY[reason.kind];
      const elapsed = formatRelativeTime(reason.occurredAt);
      return {
        collectionRequestId: item.collectionRequestId,
        severity: copy.severity,
        title: copy.title(summary.clientName),
        meta: `${copy.meta(reason.detail)} · ${elapsed}`,
        actionHref: `/collections/${item.collectionRequestId}`,
        actionLabel: copy.actionLabel,
      };
    })
    .filter((row): row is NeedsAttentionRow => row !== null)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "danger" ? -1 : 1));
}

export async function getOneTimeDashboardView(organizationId: string): Promise<OneTimeDashboardView> {
  const hasSentAnyRequest = await hasSentAnyOnDemandRequest(organizationId);
  const draftId = hasSentAnyRequest ? null : await resolveOnDemandDraft(organizationId);

  if (!hasSentAnyRequest) {
    return {
      hasSentAnyRequest,
      draftId,
      kpis: { needsReviewCount: 0, activeRequestsCount: 0, completedThisWeekCount: 0 },
      hero: { state: "calm", headline: "", subtext: "", chips: [] },
      needsAttention: [],
      inProgress: [],
    };
  }

  const db = await getDb();

  const [needsReviewItems, activeRequestsCount, completedThisWeekCount, inProgressRequests] = await Promise.all([
    getItemsNeedingReview(organizationId),
    getActiveRequestsCount(organizationId),
    getCompletedThisWeekCount(organizationId),
    db
      .select({ id: collectionRequests.id })
      .from(collectionRequests)
      .where(
        and(eq(collectionRequests.organizationId, organizationId), inArray(collectionRequests.status, IN_PROGRESS_STATUSES))
      )
      .orderBy(desc(collectionRequests.updatedAt))
      .limit(20),
  ]);

  const inProgressIds = inProgressRequests.map((row) => row.id);

  const [needsAttention, inProgress] = await Promise.all([
    buildNeedsAttentionRows(organizationId, needsReviewItems),
    buildRequestRows(organizationId, inProgressIds),
  ]);

  return {
    hasSentAnyRequest,
    draftId,
    kpis: {
      needsReviewCount: needsReviewItems.length,
      activeRequestsCount,
      completedThisWeekCount,
    },
    hero: buildHero(needsReviewItems),
    needsAttention,
    inProgress,
  };
}

// The three KPI tiles' own real drill-down lists (issue: KPI cards used to
// all point at the template gallery, /collections, regardless of which
// tile was clicked). Each returns every matching request — never capped
// like the homepage's own inProgress table — using the exact same
// status definitions the KPI counts themselves are built from, so a
// number on the tile and the length of its own drill-down list can never
// silently disagree.

export async function listNeedsReviewRequests(organizationId: string): Promise<NeedsAttentionRow[]> {
  const needsReviewItems = await getItemsNeedingReview(organizationId);
  return buildNeedsAttentionRows(organizationId, needsReviewItems);
}

export async function listActiveRequestsFull(organizationId: string): Promise<InProgressRow[]> {
  const db = await getDb();
  const rows = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, [...ACTIVE_REQUEST_STATUSES])
      )
    )
    .orderBy(desc(collectionRequests.updatedAt));
  return buildRequestRows(organizationId, rows.map((r) => r.id));
}

export async function listCompletedThisWeekFull(organizationId: string): Promise<InProgressRow[]> {
  const db = await getDb();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "completed"),
        gte(collectionRequests.completedAt, weekAgo)
      )
    )
    .orderBy(desc(collectionRequests.completedAt));
  return buildRequestRows(organizationId, rows.map((r) => r.id));
}
