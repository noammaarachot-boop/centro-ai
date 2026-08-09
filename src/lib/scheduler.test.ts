import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
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
      whatsappPhoneNumberId: "phone-1",
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

describe("runScheduledTasks — stale-conversation reminder", () => {
  it("sends the generic reminder when a requirement is genuinely still unsatisfied", async () => {
    const { orgId } = await seedStaleWaitingConversation({ withUnsatisfiedRequirement: true });

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
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
