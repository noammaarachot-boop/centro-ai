import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Rows written by the old model, moved onto the new one.
 *
 * Production contains requests whose status is literally "escalated", from
 * when escalating OVERWROTE the lifecycle. One of them is worse than stale:
 * an employee pressed "טופל", the dismissal was recorded, and the deploy that
 * could restore the status landed thirteen minutes later — so the request
 * kept its escalated status while dropping out of the very list that owns the
 * "טופל" button. It reads as "דורש טיפול" forever with no way to clear it.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { planEscalationReconciliation, applyEscalationReconciliation, clearEscalationsOnTerminalRequests } =
  await import("./reconcileEscalations");
const { getItemsNeedingReview } = await import("@/lib/data/dashboardReadModel");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let otherOrgId: string;
let clientId: string;
let serviceId: string;

beforeEach(async () => {
  await db.delete(schema.attentionDismissals);
  await db.delete(schema.auditLogs);
  await db.delete(schema.collectionRequestRequirements);
  await db.delete(schema.conversations);
  await db.delete(schema.collectionRequests);
  await db.delete(schema.clients);
  await db.delete(schema.services);
  await db.delete(schema.organizations);

  const [org] = await db.insert(schema.organizations).values({ name: "משרד" }).returning();
  const [other] = await db.insert(schema.organizations).values({ name: "אחר" }).returning();
  orgId = org.id;
  otherOrgId = other.id;
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name: "יאיר", phone: "+972500000222" })
    .returning();
  clientId = client.id;
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "s" }).returning();
  serviceId = service.id;
});

const ESCALATED_AT = new Date("2026-08-27T08:40:00.549Z");

async function seedLegacyEscalated(options: {
  organizationId?: string;
  conversationStatus?: (typeof schema.conversations.$inferInsert)["status"];
  withAuditEvent?: boolean;
  status?: (typeof schema.collectionRequests.$inferInsert)["status"];
}) {
  const org = options.organizationId ?? orgId;
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org,
      clientId,
      serviceId,
      periodLabel: "p",
      // The old model's shape, exactly as production holds it.
      status: options.status ?? "escalated",
      escalationReason: "לא ענה והבקשה עדיין לא הושלמה",
      updatedAt: new Date("2026-08-29T00:00:00Z"),
    })
    .returning();

  await db.insert(schema.conversations).values({
    organizationId: org,
    clientId,
    collectionRequestId: request.id,
    status: options.conversationStatus ?? "waiting_for_client",
  });

  if (options.withAuditEvent !== false) {
    await db.insert(schema.auditLogs).values({
      organizationId: org,
      collectionRequestId: request.id,
      eventType: "collection_request.escalated",
      actorType: "system",
      description: "לא ענה",
      occurredAt: ESCALATED_AT,
    });
  }
  return request.id;
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, id));
  return row;
};

describe("planning is read-only", () => {
  it("reports what would change and writes nothing", async () => {
    const id = await seedLegacyEscalated({});

    const plan = await planEscalationReconciliation();

    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0].toStatus).toBe("waiting_for_client");
    expect(plan.organizationsAffected).toBe(1);
    expect((await rowOf(id)).status, "the dry run touched nothing").toBe("escalated");
  });

  it("finds nothing when there is nothing to fix", async () => {
    expect((await planEscalationReconciliation()).rows).toHaveLength(0);
  });
});

describe("applying it", () => {
  it("restores the lifecycle from the conversation and keeps the escalation as a field", async () => {
    const id = await seedLegacyEscalated({ conversationStatus: "waiting_for_client" });

    await applyEscalationReconciliation(await planEscalationReconciliation());

    const row = await rowOf(id);
    expect(row.status).toBe("waiting_for_client");
    // Its OWN event time, not updatedAt — which later unrelated writes moved.
    expect(row.escalatedAt).toEqual(ESCALATED_AT);
    expect(row.escalationReason, "still escalated, so the reason still applies").not.toBeNull();
  });

  it("an open conversation means the request was active", async () => {
    const id = await seedLegacyEscalated({ conversationStatus: "open" });

    await applyEscalationReconciliation(await planEscalationReconciliation());

    expect((await rowOf(id)).status).toBe("active");
  });

  it("still reads as 'דורש טיפול' — reconciliation must not silence a live escalation", async () => {
    const id = await seedLegacyEscalated({});

    await applyEscalationReconciliation(await planEscalationReconciliation());

    const items = await getItemsNeedingReview(orgId);
    const item = items.find((i) => i.collectionRequestId === id);
    expect(item?.reasons.some((r) => r.kind === "escalated")).toBe(true);
  });

  it("falls back to updatedAt when no escalation event survives", async () => {
    const id = await seedLegacyEscalated({ withAuditEvent: false });

    await applyEscalationReconciliation(await planEscalationReconciliation());

    expect((await rowOf(id)).escalatedAt).toEqual(new Date("2026-08-29T00:00:00Z"));
  });

  it("is idempotent — a second run finds nothing left to do", async () => {
    await seedLegacyEscalated({});

    const applied = await applyEscalationReconciliation(await planEscalationReconciliation());
    expect(applied).toBe(1);

    const second = await planEscalationReconciliation();
    expect(second.rows).toHaveLength(0);
    expect(await applyEscalationReconciliation(second)).toBe(0);
  });

  it("records every change, and deletes nothing", async () => {
    const id = await seedLegacyEscalated({});

    await applyEscalationReconciliation(await planEscalationReconciliation());

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, id));
    expect(events.some((e) => e.eventType === "collection_request.escalation_reconciled")).toBe(true);
    expect(events.some((e) => e.eventType === "collection_request.escalated"), "history kept").toBe(true);
  });

  it("keeps every organization's rows to itself", async () => {
    const mine = await seedLegacyEscalated({});
    const theirs = await seedLegacyEscalated({ organizationId: otherOrgId });

    const plan = await planEscalationReconciliation();
    const orgs = new Set(plan.rows.map((r) => r.organizationId));

    expect(plan.rows).toHaveLength(2);
    expect(orgs).toEqual(new Set([orgId, otherOrgId]));
    // Each row is written under its own organization, never crossed over.
    await applyEscalationReconciliation(plan);
    expect((await rowOf(mine)).organizationId).toBe(orgId);
    expect((await rowOf(theirs)).organizationId).toBe(otherOrgId);
  });
});

describe("the request whose 'טופל' was lost", () => {
  it("clears an escalation an employee already handled, instead of resurrecting it", async () => {
    const id = await seedLegacyEscalated({});
    // The dismissal that was recorded before the code to act on it existed.
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgId,
      collectionRequestId: id,
      reasonKind: "escalated",
      sourceId: "",
      occurrenceAt: new Date("2026-08-27T08:40:00.543Z"),
      reasonDetail: "לא ענה",
    });

    await applyEscalationReconciliation(await planEscalationReconciliation());

    const row = await rowOf(id);
    expect(row.status).toBe("waiting_for_client");
    expect(row.escalatedAt, "the employee closed this — it must not come back").toBeNull();
    expect(row.escalationReason).toBeNull();

    // And no escalation reason is left in the attention list either.
    const items = await getItemsNeedingReview(orgId);
    const item = items.find((i) => i.collectionRequestId === id);
    expect(item?.reasons.some((r) => r.kind === "escalated") ?? false).toBe(false);
  });

  it("the dismissal itself is preserved as history", async () => {
    const id = await seedLegacyEscalated({});
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgId,
      collectionRequestId: id,
      reasonKind: "escalated",
      sourceId: "",
      occurrenceAt: new Date("2026-08-27T08:40:00.543Z"),
      reasonDetail: "לא ענה",
    });

    await applyEscalationReconciliation(await planEscalationReconciliation());

    expect(await db.select().from(schema.attentionDismissals)).toHaveLength(1);
  });
});

describe("a finished request never carries an escalation", () => {
  it("clears a flag left on a completed request", async () => {
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({
        organizationId: orgId,
        clientId,
        serviceId,
        periodLabel: "p",
        status: "completed",
        escalatedAt: new Date("2026-08-01T00:00:00Z"),
        escalationReason: "לא ענה",
      })
      .returning();

    expect(await clearEscalationsOnTerminalRequests()).toBe(1);

    const row = await rowOf(request.id);
    expect(row.escalatedAt).toBeNull();
    expect(row.status, "the request itself is untouched").toBe("completed");
  });

  it("leaves an open request's escalation alone", async () => {
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({
        organizationId: orgId,
        clientId,
        serviceId,
        periodLabel: "p",
        status: "waiting_for_client",
        escalatedAt: new Date("2026-08-01T00:00:00Z"),
      })
      .returning();

    expect(await clearEscalationsOnTerminalRequests()).toBe(0);
    expect((await rowOf(request.id)).escalatedAt).not.toBeNull();
  });
});
