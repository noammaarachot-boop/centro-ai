import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Free-text "I'll send it later" understanding (src/lib/ai/conversationReplyIntent.ts)
// — a client's explicit promise to send more documents later must actually
// hold back the scheduler's stale-conversation reminder until that time,
// not just get recorded and ignored.

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

async function seedStaleWaitingConversation(nextFollowUpAt: Date | null) {
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
      nextFollowUpAt,
    })
    .returning();
  return { orgId: org.id, conversationId: conversation.id };
}

describe("runScheduledTasks — nextFollowUpAt gating", () => {
  it("holds the stale-conversation reminder while nextFollowUpAt is still in the future", async () => {
    const futureFollowUp = new Date(Date.now() + 60 * 60 * 1000); // 1 hour from now
    const { orgId, conversationId } = await seedStaleWaitingConversation(futureFollowUp);

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // Still holds the promise — not cleared prematurely.
    expect(conversation.nextFollowUpAt).not.toBeNull();
  });

  it("sends the reminder and clears nextFollowUpAt once the promised time has passed", async () => {
    const pastFollowUp = new Date(Date.now() - 60 * 1000); // 1 minute ago
    const { orgId, conversationId } = await seedStaleWaitingConversation(pastFollowUp);

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.nextFollowUpAt).toBeNull();
  });

  it("sends the reminder normally when no follow-up promise was ever made", async () => {
    const { orgId } = await seedStaleWaitingConversation(null);

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
