import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * "טופל" — an employee marking one attention item as handled.
 *
 * Attention items are DERIVED, not stored: getItemsNeedingReview unions four
 * real conditions. That is why an item already disappears by itself once its
 * cause is gone, and why a cron pass cannot duplicate one — there is no row
 * to duplicate. What was missing is the human case: somebody dealt with it
 * out of band while the underlying condition legitimately still stands.
 *
 * A dismissal therefore sits ALONGSIDE the condition and never mutates it.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { getItemsNeedingReview } = await import("./dashboardReadModel");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgA: string;
let orgB: string;
let requestA: string;
let clientA: string;

async function seedOrg(name: string) {
  const [org] = await db.insert(schema.organizations).values({ name }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({
      organizationId: org.id,
      name: "לקוח",
      phone: `+9725000${Math.floor(Math.random() * 90000 + 10000)}`,
    })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "s" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org.id,
      clientId: client.id,
      serviceId: service.id,
      periodLabel: "p",
      status: "waiting_for_client",
      escalatedAt: new Date("2026-01-01T10:00:00Z"),
      escalationReason: "לא ענה",
    })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id };
}

beforeEach(async () => {
  await db.delete(schema.attentionDismissals);
  await db.delete(schema.employeeReviewItems);
  await db.delete(schema.conversations);
  await db.delete(schema.collectionRequests);
  await db.delete(schema.organizations);
  const a = await seedOrg("A");
  const b = await seedOrg("B");
  orgA = a.orgId;
  orgB = b.orgId;
  requestA = a.requestId;
  clientA = a.clientId;
});

async function dismiss(organizationId: string, requestId: string, occurrenceAt: Date, kind = "escalated") {
  await db
    .insert(schema.attentionDismissals)
    .values({ organizationId, collectionRequestId: requestId, reasonKind: kind, sourceId: "", occurrenceAt })
    .onConflictDoNothing();
}

describe("dismissing an attention item", () => {
  it("1 — a new attention item appears", async () => {
    const items = await getItemsNeedingReview(orgA);
    expect(items).toHaveLength(1);
    expect(items[0].reasons[0].kind).toBe("escalated");
  });

  it("2+3 — once handled it is gone, and stays gone on refresh", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    await dismiss(orgA, requestA, before.reasons[0].occurredAt);

    expect(await getItemsNeedingReview(orgA)).toHaveLength(0);
    // A second read is exactly what a refresh does.
    expect(await getItemsNeedingReview(orgA)).toHaveLength(0);
  });

  it("4 — the counter follows, because it IS the length of this list", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    await dismiss(orgA, requestA, before.reasons[0].occurredAt);

    // oneTimeDashboardView computes needsReviewCount as items.length, so the
    // list and the badge cannot disagree.
    expect((await getItemsNeedingReview(orgA)).length).toBe(0);
  });

  it("5 — the request itself is untouched", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    await dismiss(orgA, requestA, before.reasons[0].occurredAt);

    const [row] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, requestA));
    expect(row.status, "dismissing must never close or change a request").toBe("waiting_for_client");
    expect(row.escalationReason).toBe("לא ענה");
  });

  it("6 — completing the request clears the item on its own, with no dismissal", async () => {
    await db
      .update(schema.collectionRequests)
      .set({ status: "completed" })
      .where(eq(schema.collectionRequests.id, requestA));

    expect(await getItemsNeedingReview(orgA)).toHaveLength(0);
    expect(await db.select().from(schema.attentionDismissals)).toHaveLength(0);
  });

  it("7 — a repeated dismissal (cron, retry, double click) cannot duplicate", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    const at = before.reasons[0].occurredAt;
    await dismiss(orgA, requestA, at);
    await dismiss(orgA, requestA, at);
    await dismiss(orgA, requestA, at);

    expect(await db.select().from(schema.attentionDismissals)).toHaveLength(1);
  });

  it("8 — the same problem recurring later raises a NEW item, without reopening the old one", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    await dismiss(orgA, requestA, before.reasons[0].occurredAt);
    expect(await getItemsNeedingReview(orgA)).toHaveLength(0);

    // The request escalates again. The occurrence is the escalation's OWN
    // instant now, not the row's updatedAt — which any unrelated write moved,
    // so a dismissal's "handled up to here" mark used to drift against events
    // it had nothing to do with.
    await db
      .update(schema.collectionRequests)
      .set({ escalatedAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.collectionRequests.id, requestA));

    expect(await getItemsNeedingReview(orgA), "a genuine recurrence must surface again").toHaveLength(1);
    // The original dismissal is still on the record — nothing was reopened.
    expect(await db.select().from(schema.attentionDismissals)).toHaveLength(1);
  });

  it("9 — a dismissal in one organization never affects another", async () => {
    const [beforeA] = await getItemsNeedingReview(orgA);
    await dismiss(orgA, requestA, beforeA.reasons[0].occurredAt);

    expect(await getItemsNeedingReview(orgA)).toHaveLength(0);
    expect(await getItemsNeedingReview(orgB), "organization B is untouched").toHaveLength(1);
  });

  it("a dismissal recorded under another organization cannot hide this one's item", async () => {
    const [beforeA] = await getItemsNeedingReview(orgA);
    // Same request id, wrong organization — must not match.
    await dismiss(orgB, requestA, beforeA.reasons[0].occurredAt);

    expect(await getItemsNeedingReview(orgA)).toHaveLength(1);
  });

  it("10 — what was dismissed is preserved: who, when, and the original reason", async () => {
    const [before] = await getItemsNeedingReview(orgA);
    const [user] = await db
      .insert(schema.users)
      .values({ organizationId: orgA, email: `u-${Date.now()}@x.com`, passwordHash: "x" })
      .returning();
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgA,
      collectionRequestId: requestA,
      reasonKind: "escalated",
      sourceId: "",
      occurrenceAt: before.reasons[0].occurredAt,
      reasonDetail: "לא ענה",
      dismissedByUserId: user.id,
    });

    const [row] = await db.select().from(schema.attentionDismissals);
    expect(row.dismissedByUserId).toBe(user.id);
    expect(row.dismissedAt).toBeInstanceOf(Date);
    expect(row.reasonDetail, "the original reason is history, never rewritten").toBe("לא ענה");
  });

  it("dismissing one reason leaves the request's OTHER reasons visible", async () => {
    // conversationId and category are NOT NULL on this table.
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgA, clientId: clientA, collectionRequestId: requestA })
      .returning();
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgA,
      collectionRequestId: requestA,
      clientId: clientA,
      conversationId: conversation.id,
      clientQuestion: "מתי צריך לשלוח?",
      category: "other",
      status: "pending",
    });
    const [before] = await getItemsNeedingReview(orgA);
    expect(before.reasons).toHaveLength(2);

    const escalation = before.reasons.find((r) => r.kind === "escalated")!;
    await dismiss(orgA, requestA, escalation.occurredAt);

    const [after] = await getItemsNeedingReview(orgA);
    expect(after.reasons).toHaveLength(1);
    expect(after.reasons[0].kind).toBe("employee_question");
  });
});
