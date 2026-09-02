import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * The office's own patience, end to end.
 *
 * "מתי להעביר בקשה לטיפול אנושי?" used to be a hard-coded 3 that existed in
 * several places at once. These tests are about the property that replaced it:
 * every mechanism that cares about the threshold reads the SAME organization
 * row, so two offices can genuinely behave differently and one office cannot
 * behave two ways.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { getItemsNeedingReview } = await import("@/lib/data/dashboardReadModel");
const { loadHumanReviewAfterDays } = await import("./organizationPolicy");
const { applyTransition } = await import("@/lib/collectionRequestStateMachine");
const { ensureConversation } = await import("@/lib/conversationOrchestration");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await db.delete(schema.attentionDismissals);
  await db.delete(schema.messages);
  await db.delete(schema.collectionRequestRequirements);
  await db.delete(schema.conversations);
  await db.delete(schema.collectionRequests);
  await db.delete(schema.clients);
  await db.delete(schema.services);
  await db.delete(schema.organizations);
});

/** An organization with its own configured patience, and one late request. */
async function seedOffice(options: {
  name: string;
  humanReviewAfterDays?: number;
  ageDays: number;
  status?: (typeof schema.collectionRequests.$inferInsert)["status"];
  withRequirement?: boolean;
}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: options.name,
      // Deliberately omitted when undefined, so the column default is what
      // an untouched organization actually gets.
      ...(options.humanReviewAfterDays === undefined
        ? {}
        : { humanReviewAfterDays: options.humanReviewAfterDays }),
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 90000000 + 10000000)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "s" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org.id,
      clientId: client.id,
      serviceId: service.id,
      periodLabel: "p",
      status: options.status ?? "waiting_for_client",
      createdAt: new Date(Date.now() - options.ageDays * DAY_MS),
    })
    .returning();
  if (options.withRequirement !== false) {
    await db.insert(schema.collectionRequestRequirements).values({
      collectionRequestId: request.id,
      name: "תעודת זהות",
      requiredCount: 1,
    });
  }
  await db.insert(schema.conversations).values({
    organizationId: org.id,
    clientId: client.id,
    collectionRequestId: request.id,
    status: "waiting_for_client",
  });
  return { orgId: org.id, clientId: client.id, requestId: request.id, serviceId: service.id };
}

const overdue = async (orgId: string, requestId: string) => {
  const items = await getItemsNeedingReview(orgId);
  return (
    items
      .find((i) => i.collectionRequestId === requestId)
      ?.reasons.some((r) => r.kind === "client_overdue") ?? false
  );
};

describe("attention honours the organization's setting", () => {
  it("1 — an organization that never configured it behaves exactly as before", async () => {
    const early = await seedOffice({ name: "ברירת מחדל", ageDays: 2 });
    const late = await seedOffice({ name: "ברירת מחדל 2", ageDays: 4 });

    expect(await loadHumanReviewAfterDays(early.orgId)).toBe(3);
    expect(await overdue(early.orgId, early.requestId), "two days is not yet three").toBe(false);
    expect(await overdue(late.orgId, late.requestId)).toBe(true);
  });

  it("2 — an office set to 1 day raises it after a day", async () => {
    const office = await seedOffice({ name: "קצר", humanReviewAfterDays: 1, ageDays: 2 });

    expect(await overdue(office.orgId, office.requestId)).toBe(true);
  });

  it("3 — an office set to 10 days raises nothing at day 9", async () => {
    const patient = await seedOffice({ name: "סבלני", humanReviewAfterDays: 10, ageDays: 9 });

    expect(await overdue(patient.orgId, patient.requestId)).toBe(false);
  });

  it("3 — and does raise it once the tenth day passes", async () => {
    const patient = await seedOffice({ name: "סבלני", humanReviewAfterDays: 10, ageDays: 11 });

    expect(await overdue(patient.orgId, patient.requestId)).toBe(true);
  });

  it("10 — two offices, same request age, different answers, no leakage", async () => {
    const strict = await seedOffice({ name: "מחמיר", humanReviewAfterDays: 1, ageDays: 5 });
    const patient = await seedOffice({ name: "סבלני", humanReviewAfterDays: 20, ageDays: 5 });

    expect(await overdue(strict.orgId, strict.requestId)).toBe(true);
    expect(await overdue(patient.orgId, patient.requestId)).toBe(false);

    // And neither office can see the other's request at all.
    const strictItems = await getItemsNeedingReview(strict.orgId);
    expect(strictItems.some((i) => i.collectionRequestId === patient.requestId)).toBe(false);
  });

  it("changing the setting changes future derivations immediately", async () => {
    const office = await seedOffice({ name: "משנה דעתו", humanReviewAfterDays: 10, ageDays: 5 });
    expect(await overdue(office.orgId, office.requestId)).toBe(false);

    await db
      .update(schema.organizations)
      .set({ humanReviewAfterDays: 2 })
      .where(eq(schema.organizations.id, office.orgId));

    expect(await overdue(office.orgId, office.requestId), "the same request, re-derived").toBe(true);
  });

  it("4 — a completed request is never overdue, however impatient the office", async () => {
    const office = await seedOffice({ name: "מחמיר", humanReviewAfterDays: 1, ageDays: 30, status: "completed" });

    expect(await overdue(office.orgId, office.requestId)).toBe(false);
  });

  it("4 — nor is a cancelled one", async () => {
    const office = await seedOffice({ name: "מחמיר", humanReviewAfterDays: 1, ageDays: 30, status: "cancelled" });

    expect(await overdue(office.orgId, office.requestId)).toBe(false);
  });

  it("5 — a request with nothing still missing is never overdue", async () => {
    // The client responded with everything: inactivity is not the issue, so
    // no amount of elapsed time raises it.
    const office = await seedOffice({
      name: "מחמיר",
      humanReviewAfterDays: 1,
      ageDays: 30,
      withRequirement: false,
    });

    expect(await overdue(office.orgId, office.requestId)).toBe(false);
  });

  it("a stored value out of range never produces a zero window", async () => {
    // A zero would make every request instantly and permanently overdue.
    const office = await seedOffice({ name: "פגום", ageDays: 1 });
    await db
      .update(schema.organizations)
      .set({ humanReviewAfterDays: 0 })
      .where(eq(schema.organizations.id, office.orgId));

    expect(await loadHumanReviewAfterDays(office.orgId)).toBe(3);
    expect(await overdue(office.orgId, office.requestId)).toBe(false);
  });

  it("an unknown organization resolves to the default rather than throwing", async () => {
    expect(await loadHumanReviewAfterDays("00000000-0000-0000-0000-000000000000")).toBe(3);
  });
});

describe("6 — the engine writes deadlines from the same setting", () => {
  it("the review deadline set when a conversation opens uses the office's window", async () => {
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: "משרד", humanReviewAfterDays: 12 })
      .returning();
    const [client] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "לקוח", phone: "+972500000999" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "s" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
      .returning();

    await ensureConversation(org.id, request.id, client.id);

    const [row] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, request.id));
    const days = (row.reviewDeadlineAt!.getTime() - Date.now()) / DAY_MS;
    expect(days, "12 days, not a hard-coded 3").toBeGreaterThan(11.5);
    expect(days).toBeLessThan(12.5);
  });

  it("entering waiting_for_client restarts the window at the office's own length", async () => {
    const office = await seedOffice({ name: "משרד", humanReviewAfterDays: 20, ageDays: 0, status: "active" });

    const result = await applyTransition(office.orgId, undefined, "employee", office.requestId, "waiting_for_client");
    expect(result.ok).toBe(true);

    const [row] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, office.requestId));
    const days = (row.reviewDeadlineAt!.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(19.5);
    expect(days).toBeLessThan(20.5);
  });
});

describe("the window still re-arms per office", () => {
  it("a dismissal covers one period, and the next one reopens", async () => {
    const office = await seedOffice({ name: "משרד", humanReviewAfterDays: 2, ageDays: 2 });
    const [item] = await getItemsNeedingReview(office.orgId);
    const reason = item.reasons.find((r) => r.kind === "client_overdue")!;
    await db.insert(schema.attentionDismissals).values({
      organizationId: office.orgId,
      collectionRequestId: office.requestId,
      reasonKind: "client_overdue",
      sourceId: "",
      occurrenceAt: reason.occurredAt,
      reasonDetail: "d",
    });
    expect(await overdue(office.orgId, office.requestId), "handled for this period").toBe(false);

    // Two more days pass — one more window for THIS office.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * DAY_MS);
    const reopened = await overdue(office.orgId, office.requestId);
    clock.mockRestore();

    expect(reopened, "an old dismissal must not block a future occurrence").toBe(true);
  });

  it("the same occurrence is never raised twice", async () => {
    const office = await seedOffice({ name: "משרד", humanReviewAfterDays: 3, ageDays: 5 });

    const first = await getItemsNeedingReview(office.orgId);
    const second = await getItemsNeedingReview(office.orgId);

    const occurrencesOf = (items: typeof first) =>
      items[0].reasons.filter((r) => r.kind === "client_overdue").map((r) => r.occurredAt.getTime());
    expect(occurrencesOf(first)).toHaveLength(1);
    expect(occurrencesOf(second), "idempotent — same input, same single occurrence").toEqual(
      occurrencesOf(first)
    );
  });
});
