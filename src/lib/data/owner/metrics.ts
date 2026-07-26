import { and, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiMessages,
  auditLogs,
  collectionRequests,
  documents,
  messages,
  organizations,
} from "@/db/schema";

// Cross-organization aggregates for the Owner Dashboard's home page.
// Each metric is its own small count(*) query (matching the existing
// getDashboardCounts precedent in src/lib/data/dashboard.ts) rather than
// one large query — easier to read, and each one is cheap at this scale.

const ACTIVE_ORG_WINDOW_DAYS = 30;

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function startOfMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

const OPEN_STATUSES = ["active", "waiting_for_client", "processing"] as const;

export interface OwnerHomeMetrics {
  totalOrganizations: number;
  activeOrganizations: number;
  newOrganizationsToday: number;
  newOrganizationsThisMonth: number;
  openCollectionRequests: number;
  completedCollectionRequests: number;
  failedCollectionRequests: number;
  documentsProcessedToday: number;
  aiMessagesToday: number;
  aiTokensToday: number;
  whatsappMessagesToday: number;
  driveUploadsToday: number;
}

export async function getOwnerHomeMetrics(): Promise<OwnerHomeMetrics> {
  const db = await getDb();
  const today = startOfToday();
  const monthStart = startOfMonth();
  const activeWindowStart = new Date(
    Date.now() - ACTIVE_ORG_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );

  const [{ count: totalOrganizations }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations);

  const [{ count: activeOrganizations }] = await db
    .select({ count: sql<number>`count(distinct ${auditLogs.organizationId})::int` })
    .from(auditLogs)
    .where(gte(auditLogs.occurredAt, activeWindowStart));

  const [{ count: newOrganizationsToday }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations)
    .where(gte(organizations.createdAt, today));

  const [{ count: newOrganizationsThisMonth }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(organizations)
    .where(gte(organizations.createdAt, monthStart));

  const [{ count: openCollectionRequests }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(inArray(collectionRequests.status, [...OPEN_STATUSES]));

  const [{ count: completedCollectionRequests }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(sql`${collectionRequests.status} = 'completed'`);

  // "Failed" = escalated (the status representing workflow breakdown /
  // needs-human) — cancelled is a distinct, neutral outcome and isn't
  // counted here. See the Owner Dashboard plan's stated assumptions.
  const [{ count: failedCollectionRequests }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(sql`${collectionRequests.status} = 'escalated'`);

  const [{ count: documentsProcessedToday }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(gte(documents.receivedAt, today));

  const [{ count: aiMessagesToday, tokens: aiTokensTodayRaw }] = await db
    .select({
      count: sql<number>`count(*)::int`,
      tokens: sql<number>`coalesce(sum((${aiMessages.metadata}->'usage'->>'totalTokens')::int), 0)::int`,
    })
    .from(aiMessages)
    .where(
      and(gte(aiMessages.createdAt, today), sql`${aiMessages.role} = 'assistant'`)
    );

  const [{ count: whatsappMessagesToday }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(messages)
    .where(and(gte(messages.createdAt, today), sql`${messages.direction} = 'outbound'`));

  const [{ count: driveUploadsToday }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(gte(documents.receivedAt, today), sql`${documents.googleDriveFileId} is not null`));

  return {
    totalOrganizations,
    activeOrganizations,
    newOrganizationsToday,
    newOrganizationsThisMonth,
    openCollectionRequests,
    completedCollectionRequests,
    failedCollectionRequests,
    documentsProcessedToday,
    aiMessagesToday,
    aiTokensToday: aiTokensTodayRaw,
    whatsappMessagesToday,
    driveUploadsToday,
  };
}
