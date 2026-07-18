import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
  services,
} from "@/db/schema";

export async function listCollectionRequests(organizationId: string) {
  const db = await getDb();
  return db
    .select({
      id: collectionRequests.id,
      status: collectionRequests.status,
      periodLabel: collectionRequests.periodLabel,
      createdAt: collectionRequests.createdAt,
      clientName: clients.name,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(eq(collectionRequests.organizationId, organizationId))
    .orderBy(desc(collectionRequests.createdAt));
}

export async function getCollectionRequest(
  organizationId: string,
  id: string
) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: collectionRequests.id,
      status: collectionRequests.status,
      periodLabel: collectionRequests.periodLabel,
      createdAt: collectionRequests.createdAt,
      completedAt: collectionRequests.completedAt,
      clientId: clients.id,
      clientName: clients.name,
      serviceId: services.id,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(
      and(
        eq(collectionRequests.id, id),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listRequirementsWithDocuments(
  collectionRequestId: string
) {
  const db = await getDb();
  const requirements = await db
    .select()
    .from(collectionRequestRequirements)
    .where(
      eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
    );

  const requestDocuments = await db
    .select()
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  return requirements.map((requirement) => ({
    ...requirement,
    documents: requestDocuments.filter(
      (doc) => doc.requirementId === requirement.id
    ),
  }));
}
