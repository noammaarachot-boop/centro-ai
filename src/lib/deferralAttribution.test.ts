import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Regression — Centro must never attribute its own scheduling to the client.
 *
 * The request screen printed "נדחה לבקשת הלקוח" for anything with
 * conversations.deferredReminderAt set. Two different things set it: a real
 * client request ("אשלח מחר"), and the scheduler deferring a reminder that
 * came due outside business hours. Across production, all 11 deferrals on
 * record are the scheduler's and none is a client's — so every time that
 * sentence has ever been shown, it credited a client with something they
 * never asked for.
 *
 * The discriminator is evidence, not a guess: the client path stores the
 * client's own words (deferredReminderOriginalText, a non-nullable input on
 * that path), the scheduler stores nothing but the timestamp. These tests
 * pin that invariant, because the UI's wording now depends on it.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return { ...actual, sendTextMessage: vi.fn(), sendTemplateMessage: vi.fn(), sendInteractiveButtonsMessage: vi.fn() };
});
vi.mock("@/lib/storage/driveAdapter", () => ({ retryFailedDriveUploads: async () => 0 }));
vi.mock("@/lib/whatsapp/templateApprovalNotice", () => ({ pollTemplateApprovalIfDue: async () => false }));

const { runScheduledTasks } = await import("@/lib/scheduler");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let conversationId: string;
let seq = 0;

beforeEach(async () => {
  // Business hours that are CLOSED right now, whatever the clock says:
  // a one-minute window on a day of the week we exclude below.
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      documentCollectionEnabled: true,
      whatsappPhoneNumberId: `phone-${(seq += 1)}-${Date.now()}`,
      whatsappAccessTokenEnc: "enc",
      businessHoursStart: "09:00",
      businessHoursEnd: "09:01",
      businessDays: "0",
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
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" });
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
});

describe("a scheduler deferral is never dressed up as a client request", () => {
  it("defers outside business hours without claiming the client asked", async () => {
    await runScheduledTasks(orgId);

    const [conversation] = await db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, conversationId));

    expect(conversation.deferredReminderAt, "the reminder should have been deferred").not.toBeNull();
    // The whole point: no client words, so nothing can present this as the
    // client's doing.
    expect(
      conversation.deferredReminderOriginalText,
      "a system deferral must leave no client quote behind"
    ).toBeNull();
    expect(conversation.deferredReminderReason).toBeNull();
  });

  it("does not count a scheduler deferral against the client's deferral allowance", async () => {
    await runScheduledTasks(orgId);

    const [request] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.organizationId, orgId));

    expect(request.deferralCount, "only the client's own deferrals are counted").toBe(0);
  });

  it("records it as the scheduler's own decision in the audit trail", async () => {
    await runScheduledTasks(orgId);

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.eventType, "scheduler.reminder_deferred_outside_hours"));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].actorType, "the actor is the system, never the client").toBe("system");
  });
});
