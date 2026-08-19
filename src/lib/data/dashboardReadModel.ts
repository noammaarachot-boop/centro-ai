import { and, eq, gte, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  auditLogs,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
  employeeReviewItems,
  messages,
} from "@/db/schema";
import { isWaitingForClientCondition } from "@/lib/collectionRequestStateMachine";
import { resolveDocumentDisplayLabel } from "@/lib/documents/displayLabel";

// Single read-model layer for every owner-facing dashboard. Every function
// here only reads the real engine's own state (collectionRequests.status,
// conversations.status, documents.status, employeeReviewItems, requirement
// exceptions) and shared engine functions/selectors
// (collectionRequestStateMachine.ts's isWaitingForClientCondition /
// computeRequirementsProgress) — it never decides business state itself.
// A dashboard component must call these functions rather than querying the
// tables directly, so there is exactly one place that can ever drift from
// the engine.

// "Active" for the dashboard's own KPI tile — deliberately excludes
// "escalated" (already counted under the needs-review KPI — see
// getItemsNeedingReview below, so a request never needs to be added twice
// to make the two tiles' sum sensible) and "draft" (not yet sent to the
// client, so there's nothing "active" for the client to be doing yet).
export const ACTIVE_REQUEST_STATUSES = ["active", "waiting_for_client", "processing"] as const;

export async function getActiveRequestsCount(organizationId: string): Promise<number> {
  const db = await getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, [...ACTIVE_REQUEST_STATUSES])
      )
    );
  return count;
}

// Rolling 7-day window (status=completed AND completedAt within the last 7
// days), same definition oneTimeDashboard.ts's getOneTimeDashboardCounts
// already used — kept here as the one shared definition going forward.
export async function getCompletedThisWeekCount(organizationId: string): Promise<number> {
  const db = await getDb();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "completed"),
        gte(collectionRequests.completedAt, weekAgo)
      )
    );
  return count;
}

// The exact same OR the scheduler's own reminder pass uses (see
// collectionRequestStateMachine.ts's isWaitingForClientCondition doc
// comment) — never a dashboard-only approximation.
export async function getWaitingForClientCount(organizationId: string): Promise<number> {
  const db = await getDb();
  const rows = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .innerJoin(conversations, eq(conversations.collectionRequestId, collectionRequests.id))
    .where(and(eq(collectionRequests.organizationId, organizationId), isWaitingForClientCondition()));
  return rows.length;
}

export type ReviewReasonKind =
  | "escalated"
  | "document_needs_review"
  | "employee_question"
  | "reported_missing";

export interface ReviewReason {
  kind: ReviewReasonKind;
  detail: string;
  occurredAt: Date;
  // The underlying row's own id (employeeReviewItems.id / documents.id /
  // collectionRequestRequirements.id) — undefined for "escalated" (there's
  // no separate row to act on beyond the request itself). Lets a per-request
  // detail view (or any other consumer) act directly on the specific item
  // without a second, narrower lookup for the same table.
  sourceId?: string;
}

export interface NeedsReviewItem {
  collectionRequestId: string;
  clientId: string;
  reasons: ReviewReason[];
}

// Single centralized "does this request need a human to look at it" union
// — the 4 real sources found in the connection-verification audit, merged
// and deduplicated by collectionRequestId (a request with several problems
// at once counts once here; getItemsNeedingReview's caller can still read
// every individual reason for the per-request detail view). Never a 5th,
// dashboard-invented condition.
export async function getItemsNeedingReview(organizationId: string): Promise<NeedsReviewItem[]> {
  const db = await getDb();
  const items = new Map<string, NeedsReviewItem>();

  const addReason = (collectionRequestId: string, clientId: string, reason: ReviewReason) => {
    const existing = items.get(collectionRequestId);
    if (existing) {
      existing.reasons.push(reason);
    } else {
      items.set(collectionRequestId, { collectionRequestId, clientId, reasons: [reason] });
    }
  };

  const escalatedRequests = await db
    .select({
      id: collectionRequests.id,
      clientId: collectionRequests.clientId,
      escalationReason: collectionRequests.escalationReason,
      updatedAt: collectionRequests.updatedAt,
    })
    .from(collectionRequests)
    .where(and(eq(collectionRequests.organizationId, organizationId), eq(collectionRequests.status, "escalated")));
  for (const row of escalatedRequests) {
    addReason(row.id, row.clientId, {
      kind: "escalated",
      detail: row.escalationReason ?? "",
      occurredAt: row.updatedAt,
    });
  }

  const needsReviewDocs = await db
    .select({
      id: documents.id,
      collectionRequestId: documents.collectionRequestId,
      clientId: collectionRequests.clientId,
      displayLabel: documents.displayLabel,
      updatedAt: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(collectionRequests, eq(documents.collectionRequestId, collectionRequests.id))
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.status, "needs_review"),
        notInArray(collectionRequests.status, ["completed", "cancelled"])
      )
    );
  for (const row of needsReviewDocs) {
    addReason(row.collectionRequestId, row.clientId, {
      kind: "document_needs_review",
      // Never the raw storage filename — see src/lib/documents/displayLabel.ts.
      detail: resolveDocumentDisplayLabel(row.displayLabel),
      occurredAt: row.updatedAt,
      sourceId: row.id,
    });
  }

  const pendingQuestions = await db
    .select({
      id: employeeReviewItems.id,
      collectionRequestId: employeeReviewItems.collectionRequestId,
      clientId: employeeReviewItems.clientId,
      clientQuestion: employeeReviewItems.clientQuestion,
      createdAt: employeeReviewItems.createdAt,
    })
    .from(employeeReviewItems)
    .innerJoin(collectionRequests, eq(employeeReviewItems.collectionRequestId, collectionRequests.id))
    .where(
      and(
        eq(employeeReviewItems.organizationId, organizationId),
        eq(employeeReviewItems.status, "pending"),
        isNotNull(employeeReviewItems.collectionRequestId),
        // Defense-in-depth alongside the other two sources' own filter
        // below — applyTransition's "completed" branch
        // (collectionRequestStateMachine.ts) now auto-resolves any still-
        // pending review item the moment its request completes, so this
        // should never actually match a completed/cancelled request in
        // practice; kept as a second guarantee, matching the sibling
        // sources' own discipline, rather than relying on that alone.
        notInArray(collectionRequests.status, ["completed", "cancelled"])
      )
    );
  for (const row of pendingQuestions) {
    if (!row.collectionRequestId) continue;
    addReason(row.collectionRequestId, row.clientId, {
      kind: "employee_question",
      detail: row.clientQuestion,
      occurredAt: row.createdAt,
      sourceId: row.id,
    });
  }

  const reportedMissing = await db
    .select({
      id: collectionRequestRequirements.id,
      collectionRequestId: collectionRequestRequirements.collectionRequestId,
      clientId: collectionRequests.clientId,
      name: collectionRequestRequirements.name,
      exceptionNote: collectionRequestRequirements.exceptionNote,
      exceptionCreatedAt: collectionRequestRequirements.exceptionCreatedAt,
    })
    .from(collectionRequestRequirements)
    .innerJoin(collectionRequests, eq(collectionRequestRequirements.collectionRequestId, collectionRequests.id))
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequestRequirements.exceptionStatus, "reported_missing"),
        notInArray(collectionRequests.status, ["completed", "cancelled"])
      )
    );
  for (const row of reportedMissing) {
    addReason(row.collectionRequestId, row.clientId, {
      kind: "reported_missing",
      detail: row.exceptionNote ?? row.name,
      occurredAt: row.exceptionCreatedAt ?? new Date(0),
      sourceId: row.id,
    });
  }

  return [...items.values()];
}

// One consistent "when did anything real last happen on this request"
// source — the max of the latest real message and the latest real audit
// event, per collectionRequestId. Never an invented/artificial timestamp.
// Bulk by design: a dashboard list renders many rows at once, and this
// avoids an N+1 query per row.
export async function getLastActivityAtByRequest(
  collectionRequestIds: string[]
): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>(collectionRequestIds.map((id) => [id, null]));
  if (collectionRequestIds.length === 0) return result;

  const db = await getDb();

  const lastMessages = await db
    .select({
      collectionRequestId: conversations.collectionRequestId,
      lastMessageAt: sql<Date>`max(${messages.createdAt})`,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(inArray(conversations.collectionRequestId, collectionRequestIds))
    .groupBy(conversations.collectionRequestId);

  const lastAuditEvents = await db
    .select({
      collectionRequestId: auditLogs.collectionRequestId,
      lastAuditAt: sql<Date>`max(${auditLogs.occurredAt})`,
    })
    .from(auditLogs)
    .where(
      and(
        isNotNull(auditLogs.collectionRequestId),
        inArray(auditLogs.collectionRequestId, collectionRequestIds)
      )
    )
    .groupBy(auditLogs.collectionRequestId);

  for (const row of lastMessages) {
    if (row.collectionRequestId) result.set(row.collectionRequestId, new Date(row.lastMessageAt));
  }
  for (const row of lastAuditEvents) {
    if (!row.collectionRequestId) continue;
    const existing = result.get(row.collectionRequestId);
    const auditAt = new Date(row.lastAuditAt);
    if (!existing || auditAt > existing) result.set(row.collectionRequestId, auditAt);
  }

  return result;
}

export { computeRequirementsProgress } from "@/lib/collectionRequestStateMachine";
export type { RequirementsProgress } from "@/lib/collectionRequestStateMachine";
