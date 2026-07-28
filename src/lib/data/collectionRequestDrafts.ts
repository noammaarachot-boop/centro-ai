import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, services } from "@/db/schema";

// First-Send Journey — a Collection Request "definition" (a bare `services`
// row with collectionMode "on_demand", same underlying row a Template
// always was) counts as "in progress" for exactly as long as it has never
// actually been sent to anyone: zero collection_requests rows pointing at
// it. This is the one signal both the Dashboard's focal card (Phase B) and
// the wizard's own resume/OAuth-return path (Phase A) need — deliberately
// derived from existing data rather than a new "wizard step" column, since
// it's already unambiguous and needs no separate persistence to go stale.
export async function resolveOnDemandDraft(organizationId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: services.id, requestId: collectionRequests.id })
    .from(services)
    .leftJoin(collectionRequests, eq(collectionRequests.serviceId, services.id))
    .where(and(eq(services.organizationId, organizationId), eq(services.collectionMode, "on_demand")))
    .orderBy(desc(services.updatedAt));

  const neverSent = new Map<string, boolean>();
  for (const row of rows) {
    const wasSent = neverSent.get(row.id) ?? false;
    neverSent.set(row.id, wasSent || row.requestId !== null);
  }
  for (const row of rows) {
    if (!neverSent.get(row.id)) return row.id;
  }
  return null;
}

export async function hasSentAnyOnDemandRequest(organizationId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(and(eq(services.organizationId, organizationId), eq(services.collectionMode, "on_demand")))
    .limit(1);
  return !!row;
}
