import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Regression — a failing reminder must not re-fire on every tick.
 *
 * The scheduler claimed a reminder cycle by advancing
 * conversations.reminderAnchorAt, then RESTORED it whenever the send
 * failed. The cron runs every five minutes, so a conversation whose sends
 * kept failing was due again five minutes later, forever. Production holds
 * one conversation with 121 identical reminder rows over 53 hours and
 * another with 112 over 9 hours — every one deliveryStatus "failed", no
 * WhatsApp id. That storm is also what inflated the conversation counts and
 * produced the "duplicate reminders" the office saw.
 *
 * The property: N consecutive ticks, with the provider refusing every time,
 * must produce ONE attempt — not N.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
const sendTemplateMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
    sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});
vi.mock("@/lib/whatsapp/tokenCipher", () => ({ decryptWhatsAppToken: () => "token" }));
// Keep the tick focused on the reminder pass.
vi.mock("@/lib/storage/driveAdapter", () => ({ retryFailedDriveUploads: async () => 0 }));
vi.mock("@/lib/whatsapp/templateApprovalNotice", () => ({ pollTemplateApprovalIfDue: async () => false }));

const { runScheduledTasks } = await import("@/lib/scheduler");
const { WhatsAppSendError } = await import("@/lib/whatsapp/send");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let conversationId: string;
let seq = 0;

/** An org whose business hours are always open, so nothing defers. */
async function seedDueReminder() {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      documentCollectionEnabled: true,
      whatsappPhoneNumberId: `phone-${(seq += 1)}-${Date.now()}`,
      whatsappAccessTokenEnc: "enc",
      reminderV2Approved: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
      timezone: "Asia/Jerusalem",
      reminderIntervalHours: 6,
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000111" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org.id,
      clientId: client.id,
      serviceId: service.id,
      periodLabel: "p",
      status: "active",
      extensionActive: false,
    })
    .returning();
  await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" });
  // Anchored well past the 6-hour interval, so the reminder is due now.
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "open",
      reminderAnchorAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      updatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    })
    .returning();
  orgId = org.id;
  conversationId = conversation.id;
}

async function outboundCount() {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
  return rows.length;
}

beforeEach(async () => {
  sendTextMessage.mockReset();
  sendTemplateMessage.mockReset();
  await seedDueReminder();
});

describe("reminder scheduling under a failing provider", () => {
  it("attempts once across ten consecutive ticks, not once per tick", async () => {
    sendTemplateMessage.mockRejectedValue(new WhatsAppSendError("(#131047) Re-engagement message"));
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("(#131047) Re-engagement message"));

    for (let tick = 0; tick < 10; tick += 1) {
      await runScheduledTasks(orgId);
    }

    const attempts = await outboundCount();
    expect(attempts, "ten ticks must not mean ten client-facing reminders").toBe(1);
  });

  it("leaves the reminder cycle claimed, so the anchor moved forward", async () => {
    sendTemplateMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));

    await runScheduledTasks(orgId);

    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));
    expect(
      Date.now() - conversation.reminderAnchorAt.getTime(),
      "a consumed cycle must not leave the anchor two days in the past"
    ).toBeLessThan(60_000);
  });

  it("records every failed attempt, so a silent cycle is still traceable", async () => {
    sendTemplateMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));

    await runScheduledTasks(orgId);

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.organizationId, orgId), eq(schema.auditLogs.eventType, "scheduler.reminder_send_failed")));
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("still sends exactly one reminder when the provider accepts, and not again next tick", async () => {
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.ok" });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.ok" });

    await runScheduledTasks(orgId);
    await runScheduledTasks(orgId);
    await runScheduledTasks(orgId);

    expect(await outboundCount(), "a healthy reminder must also not repeat per tick").toBe(1);
  });

  it("becomes due again once a full interval has passed", async () => {
    sendTemplateMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));
    sendTextMessage.mockRejectedValue(new WhatsAppSendError("(#131047)"));

    await runScheduledTasks(orgId);
    expect(await outboundCount()).toBe(1);

    // The failure delays the retry by one cycle — it must not abandon it.
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(Date.now() - 7 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    await runScheduledTasks(orgId);

    expect(await outboundCount(), "the next cycle must try again").toBe(2);
  });
});
