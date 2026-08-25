import { and, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { clientServices, clients, services } from "@/db/schema";


/**
 * Builds the search predicate for a client list.
 *
 * Phone matching normalizes BOTH sides. Stored numbers are free-form
 * ("050-123-4567", "+972 50 123 4567"), so a plain ILIKE on the typed text
 * finds whichever formatting the office happened to use and misses the
 * same client written another way — the same mismatch that let one real
 * number become several clients. Digits-only comparison makes any
 * formatting of a number find it.
 */
function buildSearchCondition(search: string) {
  const term = search.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  const digits = term.replace(/[^\d]/g, "");
  const conditions = [
    ilike(clients.name, like),
    ilike(clients.email, like),
    ilike(clients.notes, like),
  ];
  if (digits.length >= 6) {
    // Match on the trailing national number rather than on "contains".
    //
    // Country prefixes differ between what is stored and what is typed:
    // "050-999-8877" and "+972509998877" are the same phone but share no
    // common substring long enough to match — the local form has a leading
    // 0 where the international form has 972. Comparing the last nine
    // digits of each makes every formatting of one number find it, which is
    // the same equivalence the WhatsApp router already applies.
    const tail = digits.slice(-9);
    conditions.push(sql`regexp_replace(${clients.phone}, '[^0-9]', '', 'g') like ${`%${tail}`}`);
  } else if (digits.length >= 3) {
    conditions.push(sql`regexp_replace(${clients.phone}, '[^0-9]', '', 'g') like ${`%${digits}%`}`);
  } else {
    conditions.push(ilike(clients.phone, like));
  }
  return or(...conditions);
}

/**
 * The organization's clients.
 *
 * Archived clients are excluded unless explicitly asked for — archiving is
 * how a client is removed from day-to-day use without destroying the
 * history attached to them (see clients.archivedAt).
 */
export async function listClients(
  organizationId: string,
  options?: { search?: string; includeArchived?: boolean; archivedOnly?: boolean }
) {
  const db = await getDb();
  const conditions = [eq(clients.organizationId, organizationId)];

  if (options?.archivedOnly) conditions.push(isNotNull(clients.archivedAt));
  else if (!options?.includeArchived) conditions.push(isNull(clients.archivedAt));

  const searchCondition = options?.search ? buildSearchCondition(options.search) : undefined;
  if (searchCondition) conditions.push(searchCondition);

  return db
    .select()
    .from(clients)
    .where(and(...conditions))
    .orderBy(clients.name);
}

/** How many of the organization's clients are archived. */
export async function countArchivedClients(organizationId: string): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(clients)
    .where(and(eq(clients.organizationId, organizationId), isNotNull(clients.archivedAt)));
  return row?.n ?? 0;
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
