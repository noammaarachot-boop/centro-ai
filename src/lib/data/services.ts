import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clientServices,
  clients,
  serviceDocumentRequirements,
  services,
} from "@/db/schema";

export async function listServices(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(services)
    .where(eq(services.organizationId, organizationId))
    .orderBy(services.name);
}

export async function getService(organizationId: string, serviceId: string) {
  const db = await getDb();
  const [service] = await db
    .select()
    .from(services)
    .where(
      and(eq(services.id, serviceId), eq(services.organizationId, organizationId))
    )
    .limit(1);
  return service ?? null;
}

export async function listServiceRequirements(serviceId: string) {
  const db = await getDb();
  return db
    .select()
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, serviceId))
    .orderBy(serviceDocumentRequirements.position, serviceDocumentRequirements.createdAt);
}

export async function listServiceClients(
  organizationId: string,
  serviceId: string
) {
  const db = await getDb();
  return db
    .select({
      assignmentId: clientServices.id,
      clientId: clients.id,
      clientName: clients.name,
      assignedAt: clientServices.assignedAt,
    })
    .from(clientServices)
    .innerJoin(clients, eq(clientServices.clientId, clients.id))
    .where(
      and(
        eq(clientServices.serviceId, serviceId),
        eq(clients.organizationId, organizationId)
      )
    )
    .orderBy(clients.name);
}

// Product Evolution M6 — the reverse of listUnassignedServicesForClient
// (src/lib/data/clients.ts): clients in the org not yet assigned to this
// service, powering the Templates page's "assign clients" picker.
export async function listUnassignedClientsForService(
  organizationId: string,
  serviceId: string
) {
  const db = await getDb();
  const assigned = await db
    .select({ clientId: clientServices.clientId })
    .from(clientServices)
    .where(eq(clientServices.serviceId, serviceId));
  const assignedIds = new Set(assigned.map((row) => row.clientId));

  const allClients = await db
    .select()
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .orderBy(clients.name);

  return allClients.filter((client) => !assignedIds.has(client.id));
}
