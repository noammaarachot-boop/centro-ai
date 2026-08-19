import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { auditLogs, organizations, services } from "@/db/schema";

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
// Settings screen polish — "connected" for Google Drive used to mean only
// "googleConnectedAt is set", never whether the stored token still
// actually works. driveAdapter.ts's uploadDocumentResiliently already
// records a real integration.google_token_refresh_failed audit event the
// moment a refresh attempt fails (see its own retry-exhaustion path) — no
// new health-check/polling infrastructure needed, just reading a signal
// that already exists. A single indexed query on audit_logs (already
// scoped by organizationId + eventType, the same shape every other real
// caller of this table uses), not a network call to Google — cheap enough
// for every Settings page load.
export async function getGoogleDriveConnectionStatus(
  organizationId: string,
  googleConnectedAt: Date | null
): Promise<"not_connected" | "connected" | "needs_reconnect"> {
  if (!googleConnectedAt) return "not_connected";

  const db = await getDb();
  const [latestFailure] = await db
    .select({ occurredAt: auditLogs.occurredAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.eventType, "integration.google_token_refresh_failed")
      )
    )
    .orderBy(desc(auditLogs.occurredAt))
    .limit(1);

  // A failure recorded before the last successful (re)connect is stale —
  // the office already fixed it by reconnecting since. Only a failure
  // AFTER the current connection was established means Centro knows,
  // right now, that today's stored token doesn't work.
  if (latestFailure && latestFailure.occurredAt > googleConnectedAt) return "needs_reconnect";
  return "connected";
}

export async function isOnDemandService(serviceId: string): Promise<boolean> {
  const db = await getDb();
  const [service] = await db
    .select({ collectionMode: services.collectionMode })
    .from(services)
    .where(eq(services.id, serviceId))
    .limit(1);
  return service?.collectionMode === "on_demand";
}
