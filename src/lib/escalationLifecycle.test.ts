import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Regression — "escalated" was doing two jobs at once.
 *
 * collectionRequests.status carries where a request is in its life AND
 * whether a human is needed, and escalateToHumanReview OVERWRITES the first
 * with the second. Once the attention was handled there was nothing to go
 * back to, so a request that was really just waiting on its client kept
 * showing as escalated in "בקשות בתהליך" forever.
 *
 * Restoring reuses the pairing isWaitingForClientCondition already encodes —
 * a conversation waiting on the client means the request is
 * waiting_for_client, an open one means active — rather than adding a second
 * state machine that could drift from it.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { restoreLifecycleAfterEscalation } = await import("./collectionRequestStateMachine");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let otherOrgId: string;
let clientId: string;

beforeEach(async () => {
  await db.delete(schema.conversations);
  await db.delete(schema.collectionRequests);
  await db.delete(schema.organizations);
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [other] = await db.insert(schema.organizations).values({ name: "Other" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000111" })
    .returning();
  orgId = org.id;
  otherOrgId = other.id;
  clientId = client.id;
});

async function seedRequest(
  status: (typeof schema.collectionRequests.$inferInsert)["status"],
  conversationStatus: (typeof schema.conversations.$inferInsert)["status"] | null
): Promise<string> {
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "s" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: orgId,
      clientId,
      serviceId: service.id,
      periodLabel: "p",
      status,
      escalationReason: "לא ענה והבקשה עדיין לא הושלמה",
    })
    .returning();
  if (conversationStatus) {
    await db.insert(schema.conversations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: request.id,
      status: conversationStatus,
    });
  }
  return request.id;
}

const statusOf = async (id: string) => {
  const [row] = await db
    .select()
    .from(schema.collectionRequests)
    .where(eq(schema.collectionRequests.id, id));
  return row;
};

describe("restoring the lifecycle after an escalation is handled", () => {
  it("a request still waiting on its client becomes 'ממתין ללקוח', not 'הוסלם'", async () => {
    // The exact scenario reported: escalated → handled → documents still
    // missing → must read as waiting for the client.
    const id = await seedRequest("escalated", "waiting_for_client");

    const restored = await restoreLifecycleAfterEscalation(orgId, id);

    expect(restored).toBe("waiting_for_client");
    expect((await statusOf(id)).status).toBe("waiting_for_client");
  });

  it("a request otherwise running becomes 'פעיל'", async () => {
    const id = await seedRequest("escalated", "open");

    expect(await restoreLifecycleAfterEscalation(orgId, id)).toBe("active");
    expect((await statusOf(id)).status).toBe("active");
  });

  it("clears the escalation reason, so no stale explanation is left on screen", async () => {
    const id = await seedRequest("escalated", "open");

    await restoreLifecycleAfterEscalation(orgId, id);

    expect((await statusOf(id)).escalationReason).toBeNull();
  });

  it("the request stays in progress — handling attention never removes it", async () => {
    const id = await seedRequest("escalated", "waiting_for_client");

    await restoreLifecycleAfterEscalation(orgId, id);

    const { status } = await statusOf(id);
    expect(["completed", "cancelled"], "only a real ending may take it out").not.toContain(status);
  });

  it("NEVER overwrites a completed request", async () => {
    const id = await seedRequest("completed", "closed");

    expect(await restoreLifecycleAfterEscalation(orgId, id)).toBeNull();
    expect((await statusOf(id)).status).toBe("completed");
  });

  it("NEVER overwrites a cancelled request", async () => {
    const id = await seedRequest("cancelled", "closed");

    expect(await restoreLifecycleAfterEscalation(orgId, id)).toBeNull();
    expect((await statusOf(id)).status).toBe("cancelled");
  });

  it("leaves a request that was never escalated alone", async () => {
    const id = await seedRequest("active", "open");

    expect(await restoreLifecycleAfterEscalation(orgId, id)).toBeNull();
    expect((await statusOf(id)).status).toBe("active");
  });

  it("a request with no conversation falls back to active rather than guessing", async () => {
    const id = await seedRequest("escalated", null);

    expect(await restoreLifecycleAfterEscalation(orgId, id)).toBe("active");
  });

  it("tenant isolation — another organization cannot restore this one's request", async () => {
    const id = await seedRequest("escalated", "waiting_for_client");

    expect(await restoreLifecycleAfterEscalation(otherOrgId, id)).toBeNull();
    expect((await statusOf(id)).status, "untouched by the wrong tenant").toBe("escalated");
  });
});
