import { and, eq, gte, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  businessTypes,
  clients,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
  services,
} from "@/db/schema";
import { AUTO_CLASSIFY_CONFIDENCE } from "@/lib/ai/businessTypeClassifier";

export type DashboardQueue =
  | "active"
  | "waiting_for_client"
  | "needs_review"
  | "processing_documents"
  | "completed_today"
  | "business_type_suggestions";

const NON_TERMINAL_STATUSES = [
  "draft",
  "active",
  "waiting_for_client",
  "processing",
  "escalated",
] as const;

// EPS Ch.12: five status cards, each with a count and a percentage of all
// active (non-terminal) collections (FR-12.2).
export async function getDashboardCounts(organizationId: string) {
  const db = await getDb();

  const [{ count: activeCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, [...NON_TERMINAL_STATUSES])
      )
    );

  const [{ count: waitingCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "waiting_for_client")
      )
    );

  const escalatedRows = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "escalated")
      )
    );

  const needsReviewDocRows = await db
    .selectDistinct({ collectionRequestId: documents.collectionRequestId })
    .from(documents)
    .innerJoin(
      collectionRequests,
      eq(documents.collectionRequestId, collectionRequests.id)
    )
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.status, "needs_review"),
        inArray(collectionRequests.status, [...NON_TERMINAL_STATUSES])
      )
    );

  // Union, not sum — a Collection Request that's both escalated and has a
  // needs_review document must only count once.
  const needsReviewCount = new Set([
    ...escalatedRows.map((r) => r.id),
    ...needsReviewDocRows.map((r) => r.collectionRequestId),
  ]).size;

  const processingRows = await db
    .selectDistinct({ collectionRequestId: documents.collectionRequestId })
    .from(documents)
    .where(
      and(
        eq(documents.organizationId, organizationId),
        eq(documents.status, "processing")
      )
    );

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const [{ count: completedTodayCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "completed"),
        gte(collectionRequests.completedAt, todayStart)
      )
    );

  // Milestone 4 ("Unified Exceptions & Review Surface", Ch.4/Ch.7): clients
  // auto-classified in the "suggested" band (70-94% — see
  // src/lib/ai/businessTypeClassifier.ts) are worth a glance, distinct from
  // the certain (95%+) majority that never needs the accountant's
  // attention at all. Counted against total clients, not active collection
  // requests — this queue isn't collection-request-shaped.
  const [{ count: clientCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));
  // A non-null confidence is, by construction, always >= SUGGESTED_CONFIDENCE
  // already (src/lib/ai/businessTypeClassifier.ts never persists a lower
  // one) — so "non-null and below the certain band" is exactly the
  // suggested band, no separate lower-bound check needed.
  const [{ count: businessTypeSuggestionCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(
      and(
        eq(clients.organizationId, organizationId),
        isNotNull(clients.businessTypeConfidence),
        lt(clients.businessTypeConfidence, AUTO_CLASSIFY_CONFIDENCE)
      )
    );

  const percentage = (count: number) =>
    activeCount === 0 ? 0 : Math.round((count / activeCount) * 100);

  return {
    active: { count: activeCount, percentage: percentage(activeCount) },
    waitingForClient: { count: waitingCount, percentage: percentage(waitingCount) },
    needsReview: { count: needsReviewCount, percentage: percentage(needsReviewCount) },
    documentsProcessing: {
      count: processingRows.length,
      percentage: percentage(processingRows.length),
    },
    completedToday: { count: completedTodayCount, percentage: percentage(completedTodayCount) },
    businessTypeSuggestions: {
      count: businessTypeSuggestionCount,
      percentage: clientCount === 0 ? 0 : Math.round((businessTypeSuggestionCount / clientCount) * 100),
    },
  };
}

export interface QueueRow {
  id: string;
  clientName: string;
  serviceName: string;
  periodLabel: string;
  status: string;
  progressPercent: number;
  missingDocuments: string[];
  lastActivity: Date;
}

async function buildQueueRow(
  row: {
    id: string;
    periodLabel: string;
    status: string;
    updatedAt: Date;
    clientName: string;
    serviceName: string;
  },
  db: Awaited<ReturnType<typeof getDb>>
): Promise<QueueRow> {
  const requirements = await db
    .select({
      id: collectionRequestRequirements.id,
      name: collectionRequestRequirements.name,
    })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.collectionRequestId, row.id));

  const requestDocuments = await db
    .select({ requirementId: documents.requirementId, status: documents.status })
    .from(documents)
    .where(eq(documents.collectionRequestId, row.id));

  const satisfiedIds = new Set(
    requestDocuments.filter((d) => d.status === "approved" && d.requirementId).map((d) => d.requirementId)
  );
  const missingDocuments = requirements
    .filter((r) => !satisfiedIds.has(r.id))
    .map((r) => r.name);
  const progressPercent =
    requirements.length === 0
      ? 100
      : Math.round(((requirements.length - missingDocuments.length) / requirements.length) * 100);

  const [conversation] = await db
    .select({ updatedAt: conversations.updatedAt })
    .from(conversations)
    .where(eq(conversations.collectionRequestId, row.id))
    .limit(1);

  return {
    id: row.id,
    clientName: row.clientName,
    serviceName: row.serviceName,
    periodLabel: row.periodLabel,
    status: row.status,
    progressPercent,
    missingDocuments,
    lastActivity: conversation?.updatedAt ?? row.updatedAt,
  };
}

// FR-12.3: selecting a card shows only the collection requests in that
// status/category — this is the drill-down query behind each queue.
export async function listQueue(
  organizationId: string,
  queue: DashboardQueue
): Promise<QueueRow[]> {
  const db = await getDb();

  const baseSelect = db
    .select({
      id: collectionRequests.id,
      periodLabel: collectionRequests.periodLabel,
      status: collectionRequests.status,
      updatedAt: collectionRequests.updatedAt,
      clientName: clients.name,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id));

  let rows: Array<{
    id: string;
    periodLabel: string;
    status: string;
    updatedAt: Date;
    clientName: string;
    serviceName: string;
  }>;

  if (queue === "active") {
    rows = await baseSelect.where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, [...NON_TERMINAL_STATUSES])
      )
    );
  } else if (queue === "waiting_for_client") {
    rows = await baseSelect.where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "waiting_for_client")
      )
    );
  } else if (queue === "completed_today") {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    rows = await baseSelect.where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "completed"),
        gte(collectionRequests.completedAt, todayStart)
      )
    );
  } else if (queue === "needs_review") {
    const needsReviewIds = await db
      .selectDistinct({ id: documents.collectionRequestId })
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), eq(documents.status, "needs_review")));
    const ids = needsReviewIds.map((r) => r.id);

    rows = await baseSelect.where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        ids.length > 0
          ? or(eq(collectionRequests.status, "escalated"), inArray(collectionRequests.id, ids))
          : eq(collectionRequests.status, "escalated")
      )
    );
  } else {
    const processingIds = await db
      .selectDistinct({ id: documents.collectionRequestId })
      .from(documents)
      .where(and(eq(documents.organizationId, organizationId), eq(documents.status, "processing")));
    const ids = processingIds.map((r) => r.id);
    rows = ids.length === 0 ? [] : await baseSelect.where(inArray(collectionRequests.id, ids));
  }

  return Promise.all(rows.map((row) => buildQueueRow(row, db)));
}

export interface BusinessTypeSuggestionRow {
  id: string;
  name: string;
  phone: string;
  businessTypeName: string | null;
  confidence: number;
}

// Milestone 4's drill-down for the "business_type_suggestions" card — a
// client-shaped list, not a collection-request-shaped one like every other
// queue, so it's its own function rather than a listQueue() branch.
export async function listBusinessTypeSuggestions(
  organizationId: string
): Promise<BusinessTypeSuggestionRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: clients.id,
      name: clients.name,
      phone: clients.phone,
      businessTypeName: businessTypes.name,
      confidence: clients.businessTypeConfidence,
    })
    .from(clients)
    .leftJoin(businessTypes, eq(clients.businessTypeId, businessTypes.id))
    .where(
      and(
        eq(clients.organizationId, organizationId),
        isNotNull(clients.businessTypeConfidence),
        lt(clients.businessTypeConfidence, AUTO_CLASSIFY_CONFIDENCE)
      )
    )
    .orderBy(clients.name);
  return rows.map((r) => ({ ...r, confidence: r.confidence ?? 0 }));
}

export async function searchClients(organizationId: string, query: string) {
  const db = await getDb();
  const like = `%${query}%`;
  return db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.organizationId, organizationId),
        sql`(${clients.name} ilike ${like} or ${clients.phone} ilike ${like})`
      )
    )
    .limit(20);
}
