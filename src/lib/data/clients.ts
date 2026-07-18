import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { clientServices, clients, services } from "@/db/schema";

export async function listClients(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(clients)
    .where(eq(clients.organizationId, organizationId))
    .orderBy(clients.name);
}

export async function getClient(organizationId: string, clientId: string) {
  const db = await getDb();
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
    .limit(1);
  return client ?? null;
}

export async function listClientServices(
  organizationId: string,
  clientId: string
) {
  const db = await getDb();
  return db
    .select({
      assignmentId: clientServices.id,
      serviceId: services.id,
      serviceName: services.name,
      assignedAt: clientServices.assignedAt,
    })
    .from(clientServices)
    .innerJoin(services, eq(clientServices.serviceId, services.id))
    .where(
      and(
        eq(clientServices.clientId, clientId),
        eq(services.organizationId, organizationId)
      )
    )
    .orderBy(services.name);
}

// Services in the org that this client is not already assigned to — powers
// the "add service" picker on the client detail page.
export async function listUnassignedServicesForClient(
  organizationId: string,
  clientId: string
) {
  const db = await getDb();
  const assigned = await db
    .select({ serviceId: clientServices.serviceId })
    .from(clientServices)
    .where(eq(clientServices.clientId, clientId));
  const assignedIds = new Set(assigned.map((row) => row.serviceId));

  const allServices = await db
    .select()
    .from(services)
    .where(eq(services.organizationId, organizationId))
    .orderBy(services.name);

  return allServices.filter((service) => !assignedIds.has(service.id));
}
