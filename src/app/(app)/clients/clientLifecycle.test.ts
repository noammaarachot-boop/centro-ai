import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

/**
 * Client search, and archiving instead of deleting.
 *
 * Deleting a client destroyed history: audit_logs.client_id is
 * ON DELETE SET NULL, so the record of what had been collected from whom
 * was silently severed, and several child tables cascade. The foreign key
 * from collection_requests only refused the delete once a request existed,
 * so the destructive path was open exactly for the clients with the least
 * protection. Archiving keeps everything and is reversible.
 *
 * Search matches phones by digits on both sides, because stored numbers are
 * free-form — the same mismatch that once let one real number become
 * several clients would otherwise make a client unfindable by their own
 * number written a different way.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({ requireSession: vi.fn(async () => currentSession) }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));
vi.mock("@/lib/ai/businessTypeClassifier", () => ({
  AUTO_CLASSIFY_CONFIDENCE: 90,
  SUGGESTED_CONFIDENCE: 60,
  classifyClientBusinessType: vi.fn(async () => ({ businessTypeId: null, confidence: 0, method: "none", reason: "stub" })),
}));

const { archiveClient, restoreClient, createClient } = await import("./actions");
const { listClients, countArchivedClients } = await import("@/lib/data/clients");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let seq = 0;

async function run(action: Promise<unknown>) {
  try {
    return { state: await action };
  } catch (error) {
    const message = String((error as Error).message ?? "");
    if (message.startsWith("NEXT_REDIRECT:")) return { redirectedTo: message.slice(14) };
    throw error;
  }
}

beforeEach(async () => {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `o-${(seq += 1)}-${Date.now()}@example.com`, passwordHash: "x" })
    .returning();
  orgId = org.id;
  currentSession = {
    userId: user.id,
    organizationId: org.id,
    organizationName: "Org",
    email: user.email,
  } as unknown as Session;
});

async function seedClient(name: string, phone: string, extra?: { email?: string; notes?: string }) {
  const [row] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name, phone, email: extra?.email ?? null, notes: extra?.notes ?? null })
    .returning();
  return row;
}

describe("client search", () => {
  it("finds a client by name, email and notes", async () => {
    await seedClient("רז שלום", "0501111111", { email: "raz@example.com", notes: "לקוח ותיק" });
    await seedClient("אורי שבתאי", "0502222222");

    expect((await listClients(orgId, { search: "רז" })).map((c) => c.name)).toEqual(["רז שלום"]);
    expect((await listClients(orgId, { search: "raz@example" })).map((c) => c.name)).toEqual(["רז שלום"]);
    expect((await listClients(orgId, { search: "ותיק" })).map((c) => c.name)).toEqual(["רז שלום"]);
  });

  it("finds a client by their phone in ANY formatting", async () => {
    await seedClient("רז שלום", "050-999-8877");

    for (const term of ["0509998877", "050-999-8877", "9998877", "+972509998877", "972509998877", "050 999 8877"]) {
      const found = await listClients(orgId, { search: term });
      expect(found.map((c) => c.name), `searching "${term}"`).toEqual(["רז שלום"]);
    }
  });

  it("returns nothing rather than everything for a non-matching search", async () => {
    await seedClient("רז שלום", "0501111111");
    expect(await listClients(orgId, { search: "zzzzz" })).toHaveLength(0);
  });

  it("does not match a different client's number", async () => {
    await seedClient("רז שלום", "0509998877");
    await seedClient("אורי שבתאי", "0501112222");
    expect((await listClients(orgId, { search: "0501112222" })).map((c) => c.name)).toEqual(["אורי שבתאי"]);
  });
});

describe("archiving a client", () => {
  it("removes them from the active list without deleting the row", async () => {
    const client = await seedClient("רז שלום", "0509998877");

    await run(archiveClient(client.id));

    expect(await listClients(orgId), "gone from the active list").toHaveLength(0);
    const rows = await db.select().from(schema.clients).where(eq(schema.clients.id, client.id));
    expect(rows, "the row itself must survive").toHaveLength(1);
    expect(rows[0].archivedAt).not.toBeNull();
  });

  it("keeps the client's history and its links intact", async () => {
    const client = await seedClient("רז שלום", "0509998877");
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "שירות" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
      .returning();
    await db.insert(schema.auditLogs).values({
      organizationId: orgId,
      clientId: client.id,
      eventType: "collection_request.created",
      actorType: "system",
      description: "נוצרה בקשה",
    });

    await run(archiveClient(client.id));

    const requests = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, request.id));
    expect(requests, "the request must still exist").toHaveLength(1);
    expect(requests[0].clientId, "and still point at the client").toBe(client.id);

    const audit = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.clientId, client.id));
    expect(audit.length, "the audit trail must still be attributable").toBeGreaterThanOrEqual(1);
  });

  it("is visible in the archived view and counted", async () => {
    const client = await seedClient("רז שלום", "0509998877");
    await run(archiveClient(client.id));

    expect((await listClients(orgId, { archivedOnly: true })).map((c) => c.name)).toEqual(["רז שלום"]);
    expect(await countArchivedClients(orgId)).toBe(1);
  });

  it("can be undone, putting the client back", async () => {
    const client = await seedClient("רז שלום", "0509998877");
    await run(archiveClient(client.id));
    await run(restoreClient(client.id));

    expect((await listClients(orgId)).map((c) => c.name)).toEqual(["רז שלום"]);
    expect(await countArchivedClients(orgId)).toBe(0);
  });

  it("records both directions in the audit trail", async () => {
    const client = await seedClient("רז שלום", "0509998877");
    await run(archiveClient(client.id));
    await run(restoreClient(client.id));

    const events = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.clientId, client.id));
    const types = events.map((e) => e.eventType);
    expect(types).toContain("client.archived");
    expect(types).toContain("client.restored");
  });

  it("does not archive another organization's client", async () => {
    const client = await seedClient("שלי", "0509998877");
    const [otherOrg] = await db.insert(schema.organizations).values({ name: "אחר" }).returning();
    const [otherUser] = await db
      .insert(schema.users)
      .values({ organizationId: otherOrg.id, email: `x-${Date.now()}@example.com`, passwordHash: "x" })
      .returning();
    currentSession = {
      userId: otherUser.id,
      organizationId: otherOrg.id,
      organizationName: "אחר",
      email: otherUser.email,
    } as unknown as Session;

    await run(archiveClient(client.id));

    const rows = await db.select().from(schema.clients).where(eq(schema.clients.id, client.id));
    expect(rows[0].archivedAt, "a tenant boundary must hold").toBeNull();
  });

  it("still refuses a duplicate phone against an ARCHIVED client, so restoring cannot collide", async () => {
    const client = await seedClient("רז שלום", "0509998877");
    await run(archiveClient(client.id));

    const form = new FormData();
    form.append("name", "מישהו אחר");
    form.append("phone", "+972509998877");
    const attempt = await run(createClient({}, form));

    expect(attempt.redirectedTo, "an archived client still owns their number").toBeUndefined();
    expect(attempt.state).toEqual({ fieldErrors: { phone: "מספר טלפון זה כבר משויך ללקוח אחר." } });
  });
});
