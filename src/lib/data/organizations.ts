import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, services } from "@/db/schema";

export async function getOrganization(organizationId: string) {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return organization ?? null;
}

// Product Evolution M9 — the real, per-item predicate every document-
// profile-learning write path checks now: Centro learns only which
// documents to collect (Architecture Ch.8), and only for a specific
// Recurring Service's own clients/requests — never for an On-Demand
// Service, regardless of what else the same organization also has.
// Checked inside each write function itself (src/lib/clientDocumentProfile.ts,
// src/lib/documentLearning.ts), not only at call sites, so this boundary
// holds even if a future caller forgets to check first.
export async function isOnDemandService(serviceId: string): Promise<boolean> {
  const db = await getDb();
  const [service] = await db
    .select({ collectionMode: services.collectionMode })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  return service?.collectionMode === "on_demand";
}
