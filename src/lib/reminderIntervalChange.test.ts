import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * DEFINED BEHAVIOUR — changing the reminder interval.
 *
 * The rule, stated once so the scheduler and the UI cannot drift apart:
 *
 *   The interval is read LIVE on every tick, and applies to EVERY request,
 *   including ones already in flight. It is not copied onto a request when
 *   the request is created.
 *
 *   The next reminder is therefore always
 *       reminderAnchorAt + reminderIntervalHours
 *   evaluated with the CURRENT setting — not the setting that was in force
 *   when the request was created or when the last reminder went out.
 *
 * Consequences, both intended:
 *   • 2h → 6h: a request last reminded 3h ago is no longer due. It becomes
 *     due 6h after its anchor. Lengthening the interval can therefore
 *     postpone a reminder that was about to fire.
 *   • 6h → 2h: a request last reminded 3h ago becomes due IMMEDIATELY,
 *     because it is already past the new interval.
 *
 * The alternative — freezing the interval per request at creation — was not
 * chosen: it would mean an office that shortens its interval keeps waiting
 * on the old one for every request already open, which is the opposite of
 * what changing a setting is for.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTemplateMessage = vi.fn();
const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
    sendTextMessage: (...a: unknown[]) => sendTextMessage(...a),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});
vi.mock("@/lib/whatsapp/tokenCipher", () => ({ decryptWhatsAppToken: () => "token" }));
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

/** A request last reminded `hoursAgo` ago, in an always-open organization. */
async function seed(intervalHours: number, hoursAgo: number) {
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
      reminderIntervalHours: intervalHours,
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
  await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות" });
  const anchor = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "open",
      reminderAnchorAt: anchor,
      updatedAt: anchor,
    })
    .returning();
  orgId = org.id;
  conversationId = conversation.id;
}

const sentCount = async () =>
  (await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId))).length;

beforeEach(() => {
  sendTemplateMessage.mockReset();
  sendTextMessage.mockReset();
  sendTemplateMessage.mockResolvedValue({ messageId: "wamid.ok" });
  sendTextMessage.mockResolvedValue({ messageId: "wamid.ok" });
});

describe("changing the reminder interval applies to requests already in flight", () => {
  it("2h → 6h: a request reminded 3h ago stops being due", async () => {
    await seed(2, 3);
    // Under the old 2h setting this is due; the office now changes to 6h.
    await db
      .update(schema.organizations)
      .set({ reminderIntervalHours: 6 })
      .where(eq(schema.organizations.id, orgId));

    await runScheduledTasks(orgId);

    expect(await sentCount(), "3h < 6h, so it must wait").toBe(0);
  });

  it("2h → 6h: it becomes due again once the NEW interval has passed", async () => {
    await seed(6, 7);
    await runScheduledTasks(orgId);
    expect(await sentCount(), "7h > 6h").toBe(1);
  });

  it("6h → 2h: a request reminded 3h ago becomes due immediately", async () => {
    await seed(6, 3);
    await db
      .update(schema.organizations)
      .set({ reminderIntervalHours: 2 })
      .where(eq(schema.organizations.id, orgId));

    await runScheduledTasks(orgId);

    expect(await sentCount(), "shortening the interval must affect open requests too").toBe(1);
  });

  it("reads the setting live — a change mid-run is picked up on the next tick, with no per-request copy", async () => {
    await seed(6, 3);
    await runScheduledTasks(orgId);
    expect(await sentCount(), "not due at 6h").toBe(0);

    await db
      .update(schema.organizations)
      .set({ reminderIntervalHours: 2 })
      .where(eq(schema.organizations.id, orgId));
    await runScheduledTasks(orgId);
    expect(await sentCount(), "due at 2h, same request, no restart needed").toBe(1);
  });

  it("a service-level override still wins over the organization default", async () => {
    await seed(2, 3);
    // Epic 3: the service may override the org. 6h here must beat the org's 2h.
    await db
      .update(schema.services)
      .set({ reminderIntervalHoursOverride: 6 })
      .where(eq(schema.services.organizationId, orgId));

    await runScheduledTasks(orgId);

    expect(await sentCount(), "the override governs this request").toBe(0);
  });
});
