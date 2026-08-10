import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Reminder infrastructure — "ביטול תזכורת כאשר הדרישה הושלמה": the
// scheduler's stale-conversation reminder must never nudge a client for
// documents that already all arrived, and must complete the request
// instead once nothing is actually missing.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const sendTextMessage = vi.fn();
const sendTemplateMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});

const { runScheduledTasks } = await import("./scheduler");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  sendTemplateMessage.mockReset();
  sendTemplateMessage.mockResolvedValue({ messageId: "wamid.out" });
});

async function seedStaleWaitingConversation(options: { withUnsatisfiedRequirement: boolean }) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      // Suffixed with a fresh uuid — Phase 1.6's unique constraint on this
      // column (see caseReview.test.ts's identical comment).
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
      reminderIntervalDays: 2,
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "waiting_for_client" })
    .returning();
  if (options.withUnsatisfiedRequirement) {
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
  }
  // Stale enough to be due regardless of the 2-day reminderIntervalDays.
  const staleUpdatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "waiting_for_client",
      updatedAt: staleUpdatedAt,
    })
    .returning();
  return { orgId: org.id, requestId: request.id, conversationId: conversation.id };
}

async function seedIdleOpenConversation(options: { withUnsatisfiedRequirement: boolean }) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
      inactivityTimeoutMinutes: 15,
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000001" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  if (options.withUnsatisfiedRequirement) {
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
  }
  // Well past the 15-minute default inactivity timeout.
  const staleUpdatedAt = new Date(Date.now() - 60 * 60 * 1000);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "open",
      updatedAt: staleUpdatedAt,
    })
    .returning();
  return { orgId: org.id, conversationId: conversation.id };
}

describe("runScheduledTasks — Phase 4.2: atomic claim prevents the idle-conversation pass from re-evaluating the same conversation on a later tick", () => {
  it("the completion gate isn't satisfied (never prompts, status stays open) — a second tick right after the first still doesn't re-touch it, because the claim already bumped updatedAt on the first", async () => {
    const { orgId, conversationId } = await seedIdleOpenConversation({ withUnsatisfiedRequirement: true });

    await runScheduledTasks(orgId);
    const [afterFirst] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(afterFirst.status).toBe("open"); // never prompted — gate not satisfied
    expect(afterFirst.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000); // claimed just now, not still the old stale timestamp

    const claimedTimestamp = afterFirst.updatedAt.getTime();
    await runScheduledTasks(orgId);
    const [afterSecond] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // Excluded by the inactivity-cutoff check before the second tick ever
    // reaches the claim at all — untouched since the first tick's claim.
    expect(afterSecond.updatedAt.getTime()).toBe(claimedTimestamp);
  });
});

describe("runScheduledTasks — stale-conversation reminder", () => {
  it("sends the generic reminder when a requirement is genuinely still unsatisfied", async () => {
    const { orgId } = await seedStaleWaitingConversation({ withUnsatisfiedRequirement: true });

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

describe("runScheduledTasks — Phase 4.3: atomic claim prevents the stale-reminder pass from re-processing the same conversation on a later tick", () => {
  it("a second tick right after the first no longer sees the conversation as stale — the claim's updatedAt bump took effect, not a second reminder", async () => {
    const { orgId, conversationId } = await seedStaleWaitingConversation({ withUnsatisfiedRequirement: true });

    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const [afterFirst] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled(); // never a second reminder moments later

    const [afterSecond] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(afterSecond.updatedAt.getTime()).toBe(afterFirst.updatedAt.getTime()); // untouched by the second tick — it was excluded before ever reaching the claim
  });
});

describe("runScheduledTasks — cancels the generic reminder once nothing is actually missing", () => {
  it("completes the request instead of sending a misleading 'still waiting' reminder when every requirement is already satisfied", async () => {
    const { orgId, requestId, conversationId } = await seedStaleWaitingConversation({ withUnsatisfiedRequirement: false });

    await runScheduledTasks(orgId);

    // No generic "still waiting for documents" reminder — nothing to wait for.
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    // Completed the same way an explicit "finished" signal would.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("קיבלתי את כל המסמכים שנדרשו:");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
  });
});

describe("runScheduledTasks — Phase 6.4: stuck 'pending' outbound message sweep", () => {
  it("flags an outbound message stuck at deliveryStatus 'pending' for longer than the threshold — never auto-resends, just marks it 'stuck' for a human to check", async () => {
    const { orgId, conversationId } = await seedIdleOpenConversation({ withUnsatisfiedRequirement: true });
    const [stuck] = await db
      .insert(schema.messages)
      .values({
        organizationId: orgId,
        conversationId,
        direction: "outbound",
        senderType: "ai",
        body: "טקסט שנתקע",
        deliveryStatus: "pending",
        createdAt: new Date(Date.now() - 15 * 60 * 1000), // well past the 10-minute threshold
      })
      .returning();

    const result = await runScheduledTasks(orgId);

    expect(result.stuckMessagesFlagged).toBe(1);
    const [after] = await db.select().from(schema.messages).where(eq(schema.messages.id, stuck.id));
    expect(after.deliveryStatus).toBe("stuck");
    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "message.stuck_pending"), eq(schema.auditLogs.organizationId, orgId)));
    expect(auditRows).toHaveLength(1);
  });

  it("never flags a recently-sent pending message still legitimately in flight", async () => {
    const { orgId, conversationId } = await seedIdleOpenConversation({ withUnsatisfiedRequirement: true });
    const [recent] = await db
      .insert(schema.messages)
      .values({
        organizationId: orgId,
        conversationId,
        direction: "outbound",
        senderType: "ai",
        body: "טקסט שזה עתה נשלח",
        deliveryStatus: "pending",
        createdAt: new Date(), // just now
      })
      .returning();

    const result = await runScheduledTasks(orgId);

    expect(result.stuckMessagesFlagged).toBe(0);
    const [after] = await db.select().from(schema.messages).where(eq(schema.messages.id, recent.id));
    expect(after.deliveryStatus).toBe("pending"); // untouched
  });

  it("a second tick right after the first never re-flags the same already-stuck message", async () => {
    const { orgId, conversationId } = await seedIdleOpenConversation({ withUnsatisfiedRequirement: true });
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "outbound",
      senderType: "ai",
      body: "טקסט שנתקע",
      deliveryStatus: "pending",
      createdAt: new Date(Date.now() - 15 * 60 * 1000),
    });

    const first = await runScheduledTasks(orgId);
    expect(first.stuckMessagesFlagged).toBe(1);

    const second = await runScheduledTasks(orgId);
    expect(second.stuckMessagesFlagged).toBe(0);

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "message.stuck_pending"), eq(schema.auditLogs.organizationId, orgId)));
    expect(auditRows).toHaveLength(1); // still only ever flagged once
  });
});
