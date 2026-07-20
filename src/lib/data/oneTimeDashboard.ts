import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, services } from "@/db/schema";

// Product Evolution M4 — the one-time workflow's own dashboard data,
// mirroring src/lib/data/dashboard.ts's pattern of small, independent,
// composable query functions rather than its actual queue vocabulary
// (which is recurring-specific: business-type suggestions, pending
// classification confirmations, etc. — none of that exists in Workflow B).
// A "Template" is a bare `services` row for a one-time organization (see
// ARCHITECTURE.md's Product Evolution chapter) — these functions count and
// list them directly via the `services` table, same as any other Service.

const ACTIVE_STATUSES = ["draft", "active", "waiting_for_client", "processing"] as const;

export async function getOneTimeDashboardCounts(organizationId: string) {
  const db = await getDb();

  const [{ count: templateCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.organizationId, organizationId));

  const [{ count: clientCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(clients)
    .where(eq(clients.organizationId, organizationId));

  const [{ count: activeRequestCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.status, [...ACTIVE_STATUSES])
      )
    );

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [{ count: completedThisWeekCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.status, "completed"),
        gte(collectionRequests.completedAt, weekAgo)
      )
    );

  return { templateCount, clientCount, activeRequestCount, completedThisWeekCount };
}

export async function listRecentOneTimeRequests(organizationId: string, limit = 10) {
  const db = await getDb();
  return db
    .select({
      id: collectionRequests.id,
      status: collectionRequests.status,
      periodLabel: collectionRequests.periodLabel,
      createdAt: collectionRequests.createdAt,
      clientName: clients.name,
      templateName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(eq(collectionRequests.organizationId, organizationId))
    .orderBy(desc(collectionRequests.createdAt))
    .limit(limit);
}
