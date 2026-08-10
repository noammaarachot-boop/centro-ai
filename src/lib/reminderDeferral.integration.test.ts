import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Reminder deferral by explicit client commitment, end to end: a real
// dated promise stores a real deferred instant and suppresses the normal
// reminder cadence; a vague promise still falls through to the pre-
// existing ack-only path unchanged.

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
    sendInteractiveButtonsMessage: vi.fn().mockResolvedValue({ messageId: "wamid.out" }),
  };
});

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { applyDeferralIfAny } = await import("./reminderDeferral");
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
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

async function seedWaitingRequest(overrides: Partial<typeof schema.organizations.$inferInsert> = {}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      // Suffixed with a fresh uuid — Phase 1.6's unique constraint on this
      // column (see caseReview.test.ts's identical comment).
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessDays: "0,1,2,3,4",
      timezone: "Asia/Jerusalem",
      ...overrides,
    })
    .returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p", status: "waiting_for_client" })
    .returning();
  await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: request.id, name: "תעודת זהות", requiredCount: 1 });
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id, status: "waiting_for_client" })
    .returning();
  return { orgId: org.id, clientId: clientRow.id, requestId: request.id, conversationId: conversation.id };
}

describe("applyDeferralIfAny — a real dated commitment", () => {
  it("'אשלח ביום חמישי' stores a resolved future instant and suppresses the normal reminder", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedWaitingRequest();
    resolveLanguageModel.mockResolvedValue({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        kind: "scheduled",
        weekday: "thursday",
        explicitDay: null,
        explicitMonth: null,
        explicitYear: null,
        relativeDays: null,
        relativeWeeks: null,
        namedPeriod: null,
      },
    });

    const handled = await applyDeferralIfAny({
      organizationId: orgId,
      conversationId,
      collectionRequestId: requestId,
      clientId,
      replyText: "אשלח ביום חמישי",
    });
    expect(handled).toBe(true);

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).not.toBeNull();
    expect(conversation.deferredReminderAt!.getTime()).toBeGreaterThan(Date.now());
    expect(conversation.deferredReminderOriginalText).toBe("אשלח ביום חמישי");
    expect(conversation.deferredReminderReason).toContain("יום חמישי");

    // Confirmation actually sent (allowFreeform text path).
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("יום חמישי");
  });

  it("changing the date afterward ('בעצם אשלח ביום ראשון') overwrites the previous deferral", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedWaitingRequest();
    resolveLanguageModel.mockResolvedValue({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: { kind: "scheduled", weekday: "thursday", explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });
    await applyDeferralIfAny({ organizationId: orgId, conversationId, collectionRequestId: requestId, clientId, replyText: "אשלח ביום חמישי" });
    const [firstDeferral] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    generateObject.mockResolvedValueOnce({
      object: { kind: "scheduled", weekday: "sunday", explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });
    await applyDeferralIfAny({ organizationId: orgId, conversationId, collectionRequestId: requestId, clientId, replyText: "בעצם אשלח ביום ראשון" });
    const [secondDeferral] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    expect(secondDeferral.deferredReminderOriginalText).toBe("בעצם אשלח ביום ראשון");
    expect(secondDeferral.deferredReminderAt!.getTime()).not.toBe(firstDeferral.deferredReminderAt!.getTime());
  });

  it("an ambiguous dated promise asks a short clarifying question instead of guessing", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedWaitingRequest();
    resolveLanguageModel.mockResolvedValue({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: { kind: "ambiguous", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });

    const handled = await applyDeferralIfAny({
      organizationId: orgId,
      conversationId,
      collectionRequestId: requestId,
      clientId,
      replyText: "אשלח מתישהו",
    });
    expect(handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toContain("לאיזה יום");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).toBeNull();
  });

  it("a vague short-term promise falls through unchanged to the pre-existing ack-only path (no stored date)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedWaitingRequest();
    resolveLanguageModel.mockResolvedValue({ modelId: "fake" });
    // The deferral classifier says not_dated...
    generateObject.mockResolvedValueOnce({
      object: { kind: "not_dated", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });
    // ...then the pre-existing classifyFollowUpIntent call recognizes the vague promise.
    generateObject.mockResolvedValueOnce({ object: { isFollowUpPromise: true } });

    const handled = await applyDeferralIfAny({
      organizationId: orgId,
      conversationId,
      collectionRequestId: requestId,
      clientId,
      replyText: "אשלח בערב",
    });
    expect(handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toBe("בסדר, תודה 😊");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).toBeNull();
  });
});

describe("scheduler — deferred reminders (mandatory: suppress until date, then act)", () => {
  it("suppresses the normal reminder entirely while the deferred date is still in the future", async () => {
    const { orgId, conversationId } = await seedWaitingRequest();
    const future = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: future, updatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));

    await runScheduledTasks(orgId);

    expect(sendTextMessage).not.toHaveBeenCalled();
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt!.getTime()).toBe(future.getTime());
  });

  it("once the deferred date has arrived, sends a reminder naming only what's still missing and clears the deferral", async () => {
    // Always-open business hours — this test is about the due-deferral
    // handling itself, not business-hours gating (covered separately below).
    const { orgId, conversationId } = await seedWaitingRequest({ businessHoursStart: "00:00", businessHoursEnd: "23:59", businessDays: "0,1,2,3,4,5,6" });
    // A recent inbound message keeps the 24h free-form session window open,
    // so the reminder's real content (which document) is visible in the
    // sent text rather than the content-free static Template.
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "אשלח ביום חמישי",
    });
    const past = new Date(Date.now() - 60 * 1000);
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: past, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    await runScheduledTasks(orgId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("תעודת זהות");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).toBeNull();
  });

  it("a deferred date that arrives while the office is closed reschedules to the next business opening instead of sending immediately", async () => {
    // businessDays "0,1,2,3,4" (Sun-Thu) — Friday is closed. isWithinBusinessHours
    // checks the real current instant (correctly — the question is whether the
    // office is open *now*, when the tick actually runs, not back when the
    // reminder first became due), so the "office is closed" side of this test
    // needs the system clock itself pinned to a Friday, not just the stored
    // deferredReminderAt value — otherwise this only passes when the suite
    // happens to run outside business hours in real wall-clock time.
    const { orgId, conversationId } = await seedWaitingRequest();
    const friday = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local, closed
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: friday, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(friday);
      await runScheduledTasks(orgId);
    } finally {
      vi.useRealTimers();
    }

    expect(sendTextMessage).not.toHaveBeenCalled();
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // Rescheduled forward — never silently dropped, never sent while closed.
    expect(conversation.deferredReminderAt).not.toBeNull();
    expect(conversation.deferredReminderAt!.getTime()).toBeGreaterThan(friday.getTime());
  });

  it("nothing actually missing by the deferred date completes the request instead of sending a misleading reminder", async () => {
    const { orgId, requestId, conversationId } = await seedWaitingRequest({ businessHoursStart: "00:00", businessHoursEnd: "23:59", businessDays: "0,1,2,3,4,5,6" });
    // Satisfy the one requirement.
    const [requirement] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirement.id,
      fileName: "id.pdf",
      status: "approved",
    });
    const past = new Date(Date.now() - 60 * 1000);
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: past, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    await runScheduledTasks(orgId);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).toBeNull();
  });

  it("double-invocation of the scheduler for the same due deferral sends only one reminder (idempotency/race safety)", async () => {
    const { orgId, conversationId } = await seedWaitingRequest({ businessHoursStart: "00:00", businessHoursEnd: "23:59", businessDays: "0,1,2,3,4,5,6" });
    const past = new Date(Date.now() - 60 * 1000);
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: past, updatedAt: new Date() })
      .where(eq(schema.conversations.id, conversationId));

    await Promise.all([runScheduledTasks(orgId), runScheduledTasks(orgId)]);

    const totalSends = sendTextMessage.mock.calls.length + sendTemplateMessage.mock.calls.length;
    expect(totalSends).toBe(1);
  });
});
