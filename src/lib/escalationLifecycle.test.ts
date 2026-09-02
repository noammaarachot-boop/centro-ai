import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Escalation is a flag on the request, not the request's status.
 *
 * collectionRequests.status used to carry two different ideas at once — where
 * a request is in its life, and whether a human is needed — because
 * escalateToHumanReview OVERWROTE the first with the second. Once the
 * attention was handled there was nothing to go back to, so the predecessor
 * of this suite tested a function that GUESSED the lifecycle back from the
 * conversation. That function is gone: the lifecycle is never lost now, so
 * there is nothing to restore.
 *
 * These tests exist to keep it that way.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { clearEscalation, escalateToHumanReview } = await import("./collectionRequestStateMachine");

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
    .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "p", status })
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

const rowOf = async (id: string) => {
  const [row] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, id));
  return row;
};

describe("escalating a request", () => {
  it("does NOT change where the request is — the exact bug this replaced", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");

    expect(await escalateToHumanReview(orgId, id, "לא ענה", "system")).toBe(true);

    const row = await rowOf(id);
    expect(row.status, "the lifecycle is still true and still there").toBe("waiting_for_client");
    expect(row.escalatedAt).not.toBeNull();
    expect(row.escalationReason).toBe("לא ענה");
  });

  it("records WHEN, so the escalation has an occurrence of its own", async () => {
    const id = await seedRequest("active", "open");
    const before = Date.now();

    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    const { escalatedAt } = await rowOf(id);
    // Not updatedAt, which any unrelated write moves — a dismissal keyed on
    // that drifted against events it had nothing to do with.
    expect(escalatedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it("a second escalation does not overwrite the first while it is open", async () => {
    const id = await seedRequest("active", "open");
    await escalateToHumanReview(orgId, id, "ראשונה", "system");
    const first = (await rowOf(id)).escalatedAt;

    expect(await escalateToHumanReview(orgId, id, "שנייה", "system"), "already claimed").toBe(false);
    expect((await rowOf(id)).escalatedAt).toEqual(first);
    expect((await rowOf(id)).escalationReason).toBe("ראשונה");
  });

  it("NEVER escalates a completed request", async () => {
    const id = await seedRequest("completed", "closed");

    expect(await escalateToHumanReview(orgId, id, "לא ענה", "system")).toBe(false);
    expect((await rowOf(id)).escalatedAt).toBeNull();
  });

  it("NEVER escalates a cancelled request", async () => {
    const id = await seedRequest("cancelled", "closed");

    expect(await escalateToHumanReview(orgId, id, "לא ענה", "system")).toBe(false);
    expect((await rowOf(id)).escalatedAt).toBeNull();
  });

  it("tenant isolation — another organization cannot escalate this one's request", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");

    expect(await escalateToHumanReview(otherOrgId, id, "לא ענה", "system")).toBe(false);
    expect((await rowOf(id)).escalatedAt).toBeNull();
  });
});

describe("clearing an escalation once it is handled", () => {
  it("clears the flag and leaves the lifecycle exactly where it was", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");
    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    const occurrence = await clearEscalation(orgId, id);

    expect(occurrence, "returns what it cleared, so a dismissal can be keyed on it").not.toBeNull();
    const row = await rowOf(id);
    expect(row.status, "never reconstructed — it was never lost").toBe("waiting_for_client");
    expect(row.escalatedAt).toBeNull();
    // The reason belongs to the escalation that just ended; leaving it would
    // keep "לא ענה…" on screen beside a request that says nothing is wrong.
    expect(row.escalationReason).toBeNull();
  });

  it("an 'active' request stays active — no guessing from the conversation", async () => {
    const id = await seedRequest("active", "open");
    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    await clearEscalation(orgId, id);

    expect((await rowOf(id)).status).toBe("active");
  });

  it("the request stays in progress — handling attention never removes it", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");
    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    await clearEscalation(orgId, id);

    const { status } = await rowOf(id);
    expect(["completed", "cancelled"], "only a real ending may take it out").not.toContain(status);
  });

  it("returns null when there is nothing escalated, and changes nothing", async () => {
    const id = await seedRequest("active", "open");

    expect(await clearEscalation(orgId, id)).toBeNull();
    expect((await rowOf(id)).status).toBe("active");
  });

  it("a second press of 'טופל' is a no-op rather than a second clear", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");
    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    expect(await clearEscalation(orgId, id)).not.toBeNull();
    expect(await clearEscalation(orgId, id)).toBeNull();
  });

  it("tenant isolation — another organization cannot clear this one's escalation", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");
    await escalateToHumanReview(orgId, id, "לא ענה", "system");

    expect(await clearEscalation(otherOrgId, id)).toBeNull();
    expect((await rowOf(id)).escalatedAt, "untouched by the wrong tenant").not.toBeNull();
  });

  it("a request can escalate again afterwards — clearing is not a permanent silence", async () => {
    const id = await seedRequest("waiting_for_client", "waiting_for_client");
    await escalateToHumanReview(orgId, id, "ראשונה", "system");
    const first = (await rowOf(id)).escalatedAt!;
    await clearEscalation(orgId, id);

    expect(await escalateToHumanReview(orgId, id, "שנייה", "system")).toBe(true);
    const second = (await rowOf(id)).escalatedAt!;
    expect(second.getTime(), "a new occurrence, not the old one").toBeGreaterThan(first.getTime());
  });
});
