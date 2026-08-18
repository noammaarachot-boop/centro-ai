import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clients, collectionRequests, serviceDocumentRequirements, services } from "@/db/schema";
import { computeRequirementsProgress, NON_TERMINAL_STATUSES } from "@/lib/collectionRequestStateMachine";

// Read model for the "בקשות איסוף" template gallery — every number here is
// a direct projection of the real engine's own tables (services,
// serviceDocumentRequirements, collectionRequests) via the shared
// NON_TERMINAL_STATUSES/computeRequirementsProgress the state machine
// itself defines. Never a manual counter column, never a second
// completion/activity algorithm.

export interface TemplateSummary {
  id: string;
  name: string;
  description: string | null;
  requirementCount: number;
  activeRequestCount: number;
}

// One bulk pass per count (never per-template N+1) — a template gallery
// can reasonably have dozens of cards.
export async function listTemplatesWithActiveCounts(organizationId: string): Promise<TemplateSummary[]> {
  const db = await getDb();

  const templates = await db
    .select({ id: services.id, name: services.name, description: services.description })
    .from(services)
    .where(and(eq(services.organizationId, organizationId), eq(services.collectionMode, "on_demand")))
    .orderBy(services.name);

  if (templates.length === 0) return [];
  const templateIds = templates.map((t) => t.id);

  const requirementCounts = await db
    .select({
      serviceId: serviceDocumentRequirements.serviceId,
      count: sql<number>`count(*)::int`,
    })
    .from(serviceDocumentRequirements)
    .where(inArray(serviceDocumentRequirements.serviceId, templateIds))
    .groupBy(serviceDocumentRequirements.serviceId);
  const requirementCountByService = new Map(requirementCounts.map((r) => [r.serviceId, r.count]));

  const activeCounts = await db
    .select({
      serviceId: collectionRequests.serviceId,
      count: sql<number>`count(*)::int`,
    })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        inArray(collectionRequests.serviceId, templateIds),
        inArray(collectionRequests.status, NON_TERMINAL_STATUSES)
      )
    )
    .groupBy(collectionRequests.serviceId);
  const activeCountByService = new Map(activeCounts.map((r) => [r.serviceId, r.count]));

  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description,
    requirementCount: requirementCountByService.get(template.id) ?? 0,
    activeRequestCount: activeCountByService.get(template.id) ?? 0,
  }));
}

// Among the given candidate clientIds, which already have a non-terminal
// collection request from this exact template — the single check both the
// send action's duplicate guard and any "already active" UI hint must use.
export async function findClientIdsWithActiveRequest(
  organizationId: string,
  templateId: string,
  clientIds: string[]
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .select({ clientId: collectionRequests.clientId })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.serviceId, templateId),
        inArray(collectionRequests.clientId, clientIds),
        inArray(collectionRequests.status, NON_TERMINAL_STATUSES)
      )
    );
  return new Set(rows.map((r) => r.clientId));
}

export interface ActiveTemplateRequest {
  collectionRequestId: string;
  clientId: string;
  clientName: string;
  status: (typeof collectionRequests.status.enumValues)[number];
  satisfiedCount: number;
  totalCount: number;
  missingRequirementNames: string[];
}

// The "click a template, see its active requests" view — who, real
// status, real X/Y progress and real missing-requirement names, all via
// computeRequirementsProgress (the same function checkCompletionGate and
// the dashboard both already use). Never a parallel completion check.
export async function listActiveRequestsForTemplate(
  organizationId: string,
  templateId: string
): Promise<ActiveTemplateRequest[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: collectionRequests.id,
      clientId: clients.id,
      clientName: clients.name,
      status: collectionRequests.status,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.serviceId, templateId),
        inArray(collectionRequests.status, NON_TERMINAL_STATUSES)
      )
    )
    .orderBy(clients.name);

  return Promise.all(
    rows.map(async (row) => {
      const progress = await computeRequirementsProgress(row.id);
      return {
        collectionRequestId: row.id,
        clientId: row.clientId,
        clientName: row.clientName,
        status: row.status,
        satisfiedCount: progress.satisfiedCount,
        totalCount: progress.totalCount,
        missingRequirementNames: progress.missingRequirementNames,
      };
    })
  );
}
