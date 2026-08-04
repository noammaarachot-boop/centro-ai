import { and, asc, eq } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { collectionRequestRequirements, collectionRequests } from "@/db/schema";

// Reads the frozen, per-request document-requirement snapshot
// (collectionRequestRequirements) — the single source of truth for what a
// specific Collection Request asks its client for. That snapshot is built at
// send time from serviceDocumentRequirements + any per-client
// clientDocumentRequirements deviations, so this function needs no knowledge
// of templates or clients: it just reads what was actually frozen for THIS
// request. Never a hardcoded list.
//
// Tenant isolation: the caller passes organizationId and we join through
// collectionRequests to verify the request belongs to that organization, so
// one tenant's request can never surface another tenant's requirements.
export async function getRequestRequirementNames(
  organizationId: string,
  collectionRequestId: string,
  // Optional injection point for tests (in-memory PGlite). Production always
  // uses the shared connection.
  dbOverride?: Database
): Promise<string[]> {
  const db = dbOverride ?? (await getDb());
  const rows = await db
    .select({ name: collectionRequestRequirements.name })
    .from(collectionRequestRequirements)
    .innerJoin(
      collectionRequests,
      eq(collectionRequestRequirements.collectionRequestId, collectionRequests.id)
    )
    .where(
      and(
        eq(collectionRequestRequirements.collectionRequestId, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .orderBy(asc(collectionRequestRequirements.createdAt));
  return rows.map((row) => row.name);
}

// Meta template BODY parameters cannot contain newline characters, tabs, or
// more than four consecutive spaces (a hard Cloud API constraint), so the
// dynamic document list for centro_initial_request_v2's {{1}} placeholder
// must be a single-line, comma-separated string. A bulleted multi-line list
// is not representable in a template parameter and would be rejected at send
// time — see docs/whatsapp-connect-implementation.md.
export function formatRequirementListForTemplateParam(names: string[]): string {
  return names.join(", ");
}
