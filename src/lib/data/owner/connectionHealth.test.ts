import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// getSendFailureSignal used to compute the signal for EVERY organization
// and then pick one out of the resulting map. These prove the scoped
// rewrite kept the meaning of the signal exactly — self-healing on a
// successful send, counting only failures newer than that send — while
// making one tenant's answer genuinely independent of every other tenant's
// data.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { getSendFailureSignal, getSendFailureSignals } = await import("./connectionHealth");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
  await db.execute(sql`select 1`);
}, 60_000);

let phoneCounter = 0;

/** An organization with one conversation ready to hang messages off. */
async function seedOrg(name: string) {
  const [org] = await db.insert(schema.organizations).values({ name }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+97250000${(phoneCounter += 1).toString().padStart(4, "0")}` })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({ organizationId: org.id, name: "שירות" })
    .returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id })
    .returning();
  return { orgId: org.id, conversationId: conversation.id };
}

async function addMessage(
  org: { orgId: string; conversationId: string },
  deliveryStatus: string | null,
  createdAt: Date,
  direction: "inbound" | "outbound" = "outbound"
) {
  await db.insert(schema.messages).values({
    organizationId: org.orgId,
    conversationId: org.conversationId,
    direction,
    senderType: "system",
    body: "x",
    deliveryStatus,
    createdAt,
  });
}

const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 12, minute));

describe("getSendFailureSignal — tenant isolation", () => {
  // The regression the rewrite exists to prevent: B's failures leaking into
  // A's answer (and vice versa) because the aggregate spanned all tenants.
  it("organization B's failures do not affect organization A's signal", async () => {
    const a = await seedOrg("A");
    const b = await seedOrg("B");

    // A: clean — one successful send, nothing failed.
    await addMessage(a, "sent", T(1));

    // B: loudly broken — five consecutive failures, no success at all.
    for (let i = 0; i < 5; i += 1) await addMessage(b, "failed", T(10 + i));

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 0,
      lastSuccessfulSendAt: T(1),
    });
    await expect(getSendFailureSignal(b.orgId)).resolves.toEqual({
      consecutiveSendFailures: 5,
      lastSuccessfulSendAt: null,
    });
  });

  // The inverse direction: B succeeding must not heal A.
  it("organization B's success does not clear organization A's failures", async () => {
    const a = await seedOrg("A2");
    const b = await seedOrg("B2");

    await addMessage(a, "failed", T(1));
    await addMessage(a, "failed", T(2));
    await addMessage(b, "sent", T(50)); // newer than every one of A's failures

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 2,
      lastSuccessfulSendAt: null,
    });
  });

  it("an organization with no messages at all reports a clean signal", async () => {
    const a = await seedOrg("Empty");
    const b = await seedOrg("Noisy");
    await addMessage(b, "failed", T(1));

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 0,
      lastSuccessfulSendAt: null,
    });
  });
});

describe("getSendFailureSignal — the signal's meaning is unchanged", () => {
  it("counts only failures NEWER than the last success (self-healing)", async () => {
    const a = await seedOrg("Healing");
    await addMessage(a, "failed", T(1));
    await addMessage(a, "failed", T(2));
    await addMessage(a, "sent", T(3)); // the cutoff moves forward
    await addMessage(a, "failed", T(4));

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 1,
      lastSuccessfulSendAt: T(3),
    });
  });

  it("collapses to zero once a send succeeds after the failures", async () => {
    const a = await seedOrg("Recovered");
    await addMessage(a, "failed", T(1));
    await addMessage(a, "failed", T(2));
    await addMessage(a, "failed", T(3));
    await addMessage(a, "sent", T(4));

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 0,
      lastSuccessfulSendAt: T(4),
    });
  });

  it("ignores inbound messages and non-failed delivery statuses", async () => {
    const a = await seedOrg("Mixed");
    await addMessage(a, "failed", T(5), "inbound"); // inbound: not a send
    await addMessage(a, "pending", T(6)); // in flight, not yet a failure
    await addMessage(a, null, T(7)); // no status recorded
    await addMessage(a, "failed", T(8));

    await expect(getSendFailureSignal(a.orgId)).resolves.toEqual({
      consecutiveSendFailures: 1,
      lastSuccessfulSendAt: null,
    });
  });
});

// The scoped function must stay a drop-in replacement for the map lookup it
// replaced — same number, same timestamp, for every organization present.
describe("getSendFailureSignal agrees with getSendFailureSignals", () => {
  it("returns exactly what the all-tenants aggregate reports per organization", async () => {
    const a = await seedOrg("Agree A");
    const b = await seedOrg("Agree B");
    await addMessage(a, "failed", T(1));
    await addMessage(a, "sent", T(2));
    await addMessage(a, "failed", T(3));
    await addMessage(b, "failed", T(4));

    const all = await getSendFailureSignals();
    for (const org of [a, b]) {
      expect(await getSendFailureSignal(org.orgId)).toEqual(all.get(org.orgId));
    }
  });
});
