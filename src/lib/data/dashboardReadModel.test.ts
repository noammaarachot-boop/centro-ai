import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Proves the dashboard read model agrees with the real engine — never a
// parallel/approximate calculation. Each test seeds a concrete fixture and
// checks the read model against what the engine itself would decide for
// that same fixture (checkCompletionGate for X/Y, the shared
// isWaitingForClientCondition for "waiting for client").

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const {
  getActiveRequestsCount,
  getCompletedThisWeekCount,
  getWaitingForClientCount,
  getItemsNeedingReview,
  getLastActivityAtByRequest,
  computeRequirementsProgress,
} = await import("./dashboardReadModel");
const { checkCompletionGate } = await import("@/lib/collectionRequestStateMachine");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrgClientService(orgName = "Org") {
  const [org] = await db.insert(schema.organizations).values({ name: orgName }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  return { orgId: org.id, clientId: client.id, serviceId: service.id };
}

async function seedRequest(
  orgId: string,
  clientId: string,
  serviceId: string,
  overrides: Partial<typeof schema.collectionRequests.$inferInsert> = {}
) {
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId, serviceId, periodLabel: "p", ...overrides })
    .returning();
  return request;
}

async function seedConversation(
  orgId: string,
  clientId: string,
  requestId: string,
  status: (typeof schema.conversationStatus.enumValues)[number]
) {
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: orgId, clientId, collectionRequestId: requestId, status })
    .returning();
  return conversation;
}

describe("getActiveRequestsCount / getCompletedThisWeekCount — real statuses only", () => {
  it("counts active/waiting_for_client/processing, excludes draft/escalated/completed/cancelled", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    await seedRequest(orgId, clientId, serviceId, { status: "draft" });
    await seedRequest(orgId, clientId, serviceId, { status: "active" });
    await seedRequest(orgId, clientId, serviceId, { status: "waiting_for_client" });
    await seedRequest(orgId, clientId, serviceId, { status: "processing" });
    await seedRequest(orgId, clientId, serviceId, { status: "escalated" });
    await seedRequest(orgId, clientId, serviceId, { status: "cancelled" });

    expect(await getActiveRequestsCount(orgId)).toBe(3);
  });

  it("counts completed only within the last 7 days, matching the engine's own completedAt", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const now = new Date();
    const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    await seedRequest(orgId, clientId, serviceId, { status: "completed", completedAt: eightDaysAgo });
    await seedRequest(orgId, clientId, serviceId, { status: "completed", completedAt: twoDaysAgo });
    await seedRequest(orgId, clientId, serviceId, { status: "active" });

    expect(await getCompletedThisWeekCount(orgId)).toBe(1);
  });
});

describe("getWaitingForClientCount — same canonical condition the scheduler's reminder pass uses", () => {
  it("counts waiting_for_client/waiting_for_client and open/active, excludes every other combination", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();

    const matchingA = await seedRequest(orgId, clientId, serviceId, { status: "waiting_for_client" });
    await seedConversation(orgId, clientId, matchingA.id, "waiting_for_client");

    const matchingB = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    await seedConversation(orgId, clientId, matchingB.id, "open");

    const nonMatchingA = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    await seedConversation(orgId, clientId, nonMatchingA.id, "waiting_for_client");

    const nonMatchingB = await seedRequest(orgId, clientId, serviceId, { status: "waiting_for_client" });
    await seedConversation(orgId, clientId, nonMatchingB.id, "human_control");

    const nonMatchingC = await seedRequest(orgId, clientId, serviceId, { status: "completed" });
    await seedConversation(orgId, clientId, nonMatchingC.id, "closed");

    expect(await getWaitingForClientCount(orgId)).toBe(2);
  });
});

describe("computeRequirementsProgress / checkCompletionGate — X/Y agrees exactly with the completion decision", () => {
  it("progress reflects satisfied vs total, and the gate only clears once satisfiedCount === totalCount", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const request = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    const [req1] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: "תעודת זהות" })
      .returning();
    const [req2] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: "תלוש שכר" })
      .returning();

    let progress = await computeRequirementsProgress(request.id);
    expect(progress).toEqual({ satisfiedCount: 0, totalCount: 2, unsatisfiedCount: 2, hasProcessingDocuments: false });
    expect(await checkCompletionGate(request.id)).not.toBeNull();

    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: request.id,
      requirementId: req1.id,
      status: "approved",
      fileName: "id.pdf",
    });

    progress = await computeRequirementsProgress(request.id);
    expect(progress.satisfiedCount).toBe(1);
    expect(progress.unsatisfiedCount).toBe(1);
    expect(await checkCompletionGate(request.id)).not.toBeNull();

    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: request.id,
      requirementId: req2.id,
      status: "approved",
      fileName: "payslip.pdf",
    });

    progress = await computeRequirementsProgress(request.id);
    expect(progress.satisfiedCount).toBe(2);
    expect(progress.unsatisfiedCount).toBe(0);
    expect(await checkCompletionGate(request.id)).toBeNull();
  });

  it("a processing document blocks the gate even when every requirement's own count is already satisfied", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const request = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: request.id,
      status: "processing",
      fileName: "id.pdf",
    });

    const progress = await computeRequirementsProgress(request.id);
    expect(progress.hasProcessingDocuments).toBe(true);
    expect(await checkCompletionGate(request.id)).not.toBeNull();
  });
});

describe("getItemsNeedingReview — union of the 4 real sources, deduplicated by collectionRequestId", () => {
  it("merges an escalated status and a needs_review document on the same request into one item with two reasons", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const request = await seedRequest(orgId, clientId, serviceId, {
      status: "escalated",
      escalationReason: "חלפו 3 ימים ללא השלמת המסמכים",
    });
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: request.id,
      status: "needs_review",
      fileName: "unclear.pdf",
    });

    const items = await getItemsNeedingReview(orgId);
    expect(items).toHaveLength(1);
    expect(items[0].collectionRequestId).toBe(request.id);
    expect(items[0].reasons.map((r) => r.kind).sort()).toEqual(["document_needs_review", "escalated"]);
  });

  it("picks up a pending employee question and a reported_missing exception as separate items", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();

    const requestA = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    const conversationA = await seedConversation(orgId, clientId, requestA.id, "open");
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestA.id,
      conversationId: conversationA.id,
      clientQuestion: "אפשר לשלוח צילום מסך במקום המקור?",
      category: "alternative_or_policy_question",
      status: "pending",
    });

    const requestB = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    await db.insert(schema.collectionRequestRequirements).values({
      collectionRequestId: requestB.id,
      name: "אישור ניכוי מס במקור",
      exceptionStatus: "reported_missing",
      exceptionNote: "אין לי את זה",
    });

    const items = await getItemsNeedingReview(orgId);
    const byRequest = new Map(items.map((i) => [i.collectionRequestId, i]));
    expect(byRequest.get(requestA.id)?.reasons[0].kind).toBe("employee_question");
    expect(byRequest.get(requestB.id)?.reasons[0].kind).toBe("reported_missing");
  });

  it("excludes needs_review documents and reported_missing exceptions once the request is completed or cancelled", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const completed = await seedRequest(orgId, clientId, serviceId, { status: "completed" });
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: completed.id,
      status: "needs_review",
      fileName: "old.pdf",
    });

    expect(await getItemsNeedingReview(orgId)).toHaveLength(0);
  });
});

describe("getLastActivityAtByRequest — max of the latest real message and the latest real audit event", () => {
  it("picks whichever of the two real sources is more recent, per request", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const requestA = await seedRequest(orgId, clientId, serviceId, { status: "active" });
    const conversationA = await seedConversation(orgId, clientId, requestA.id, "open");
    const requestB = await seedRequest(orgId, clientId, serviceId, { status: "active" });

    const earlier = new Date("2026-08-01T10:00:00Z");
    const later = new Date("2026-08-03T10:00:00Z");

    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId: conversationA.id,
      direction: "inbound",
      senderType: "client",
      body: "שלחתי את המסמך",
      createdAt: earlier,
    });
    await db.insert(schema.auditLogs).values({
      organizationId: orgId,
      collectionRequestId: requestA.id,
      eventType: "document.approved",
      actorType: "employee",
      description: "אושר",
      occurredAt: later,
    });
    await db.insert(schema.auditLogs).values({
      organizationId: orgId,
      collectionRequestId: requestB.id,
      eventType: "collection_request.created",
      actorType: "system",
      description: "נוצר",
      occurredAt: earlier,
    });

    const result = await getLastActivityAtByRequest([requestA.id, requestB.id]);
    expect(result.get(requestA.id)?.toISOString()).toBe(later.toISOString());
    expect(result.get(requestB.id)?.toISOString()).toBe(earlier.toISOString());
  });

  it("returns null for a request with no messages or audit events at all", async () => {
    const { orgId, clientId, serviceId } = await seedOrgClientService();
    const request = await seedRequest(orgId, clientId, serviceId, { status: "draft" });

    const result = await getLastActivityAtByRequest([request.id]);
    expect(result.get(request.id)).toBeNull();
  });
});
