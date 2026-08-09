import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// scheduleCaseReviewRelay — the real-time, after()-driven counterpart to
// scheduler.ts's cron sweep of conversations.pendingCaseReviewAt. These
// tests exercise the relay function directly (never through the real
// scheduleAfterResponse/after() trigger, which is a documented no-op
// outside a real request scope — see scheduleAfterResponse.ts and every
// other test in this codebase that relies on the same convention), proving
// three properties the design depends on: (1) genuine debounce — a
// pendingCaseReviewAt pushed forward mid-wait is picked up with no
// separate "cancel" step; (2) the atomic claim means two relays (or a
// relay racing the cron sweep) can never both send; (3) a relay that
// exceeds its own safe wait budget gives up cleanly and leaves the row for
// the existing cron backstop, rather than sending late or hanging forever.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: vi.fn().mockResolvedValue({ messageId: "wamid.out" }),
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

const { scheduleCaseReviewRelay, CASE_REVIEW_RELAY_MAX_WAIT_MS } = await import("./caseReview");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

async function seedWaitingRequest(pendingCaseReviewAt: Date) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: `phone-${Date.now()}-${Math.random()}`,
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
      timezone: "Asia/Jerusalem",
    })
    .returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: `+97250${Math.floor(Math.random() * 10_000_000)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({
      collectionRequestId: request.id,
      name: "תעודת זהות",
      requiredCount: 1,
    })
    .returning();
  // These tests are purely about the relay MECHANISM (debounce, claim
  // race-safety) — sendTextMessage firing is only a proxy signal that the
  // review actually ran. Not about summary content, so a second
  // requirement is left genuinely missing here on purpose, giving
  // runAutomaticCaseStatusReview's own "nothing real to report yet" rule
  // (caseReview.ts) something real to report — this one already-approved
  // document — so the relay's own send still fires as these tests expect.
  await db.insert(schema.collectionRequestRequirements).values({
    collectionRequestId: request.id,
    name: "רישיון נהיגה",
    requiredCount: 1,
  });
  await db.insert(schema.documents).values({
    organizationId: org.id,
    collectionRequestId: request.id,
    requirementId: requirement.id,
    fileName: "id.jpg",
    status: "approved",
  });
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: clientRow.id,
      collectionRequestId: request.id,
      status: "open",
      pendingCaseReviewAt,
    })
    .returning();
  return { org, clientRow, request, conversation };
}

describe("scheduleCaseReviewRelay", () => {
  it("fires exactly one review once the due time passes", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 150));

    await scheduleCaseReviewRelay({
      organizationId: org.id,
      conversationId: conversation.id,
      collectionRequestId: request.id,
      clientId: clientRow.id,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [updated] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    expect(updated.pendingCaseReviewAt).toBeNull();
  }, 15_000);

  it("debounces: a pendingCaseReviewAt pushed forward mid-wait is picked up without a separate cancel step", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 150));

    const relayPromise = scheduleCaseReviewRelay({
      organizationId: org.id,
      conversationId: conversation.id,
      collectionRequestId: request.id,
      clientId: clientRow.id,
    });

    // Simulates a second document arriving mid-wait — conversationActions.ts
    // itself does this unconditionally; the relay must pick it up on its
    // own next wake rather than firing at the original (now stale) time.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const newDueAt = new Date(Date.now() + 200);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: newDueAt }).where(eq(schema.conversations.id, conversation.id));

    expect(sendTextMessage).not.toHaveBeenCalled();

    await relayPromise;

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [updated] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    expect(updated.pendingCaseReviewAt).toBeNull();
  }, 15_000);

  it("fires correctly for a burst spread over a realistic span, even though the FIRST relay's own budget alone can't cover the whole span (regression: a real production burst spread over ~21s made a single 'first document only' relay give up before the real due time — every document now spawns its own relay instead)", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 200));
    const params = {
      organizationId: org.id,
      conversationId: conversation.id,
      collectionRequestId: request.id,
      clientId: clientRow.id,
    };

    // Document 1's relay starts immediately (its own due time: now + 200ms).
    const relay1 = scheduleCaseReviewRelay(params);

    // Document 2 arrives mid-wait (mirrors conversationActions.ts: pushes
    // pendingCaseReviewAt forward, and — per the fix — spawns its OWN relay
    // too, not just relying on relay1).
    await new Promise((resolve) => setTimeout(resolve, 80));
    await db.update(schema.conversations).set({ pendingCaseReviewAt: new Date(Date.now() + 200) }).where(eq(schema.conversations.id, conversation.id));
    const relay2 = scheduleCaseReviewRelay(params);

    // Document 3 arrives mid-wait again — same pattern.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await db.update(schema.conversations).set({ pendingCaseReviewAt: new Date(Date.now() + 200) }).where(eq(schema.conversations.id, conversation.id));
    const relay3 = scheduleCaseReviewRelay(params);

    await Promise.all([relay1, relay2, relay3]);

    // Exactly one summary, fired by whichever relay's own claim won —
    // never zero (the old bug: everyone gives up too early) and never more
    // than one.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [updated] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
    expect(updated.pendingCaseReviewAt).toBeNull();
  }, 15_000);

  it("never sends twice when two relays race the same due time (claim race safety)", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 150));

    const params = {
      organizationId: org.id,
      conversationId: conversation.id,
      collectionRequestId: request.id,
      clientId: clientRow.id,
    };
    await Promise.all([scheduleCaseReviewRelay(params), scheduleCaseReviewRelay(params), scheduleCaseReviewRelay(params)]);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("never sends twice when a relay races a cron-style claim on the exact same due row", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 150));

    // Simulates scheduler.ts's own atomic claim landing at almost the same
    // moment as the relay's — exactly the same compare-and-swap, called
    // independently, the way a real concurrent cron tick would.
    async function cronStyleClaim() {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const [row] = await db
        .select({ pendingCaseReviewAt: schema.conversations.pendingCaseReviewAt })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversation.id))
        .limit(1);
      if (!row?.pendingCaseReviewAt) return false;
      const claimed = await db
        .update(schema.conversations)
        .set({ pendingCaseReviewAt: null })
        .where(eq(schema.conversations.id, conversation.id))
        .returning({ id: schema.conversations.id });
      return claimed.length > 0;
    }

    await Promise.all([
      scheduleCaseReviewRelay({
        organizationId: org.id,
        conversationId: conversation.id,
        collectionRequestId: request.id,
        clientId: clientRow.id,
      }),
      cronStyleClaim(),
    ]);

    // Either the relay claimed and sent (1 send), or the cron-style claim
    // won the row first and the relay's own claim attempt correctly
    // matched zero rows (0 sends from the relay) — never both.
    expect(sendTextMessage.mock.calls.length).toBeLessThanOrEqual(1);
  }, 15_000);

  it("returns immediately, without sending, once pendingCaseReviewAt is already cleared", async () => {
    const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 50_000));
    await db.update(schema.conversations).set({ pendingCaseReviewAt: null }).where(eq(schema.conversations.id, conversation.id));

    await scheduleCaseReviewRelay({
      organizationId: org.id,
      conversationId: conversation.id,
      collectionRequestId: request.id,
      clientId: clientRow.id,
    });

    expect(sendTextMessage).not.toHaveBeenCalled();
  }, 15_000);

  it("gives up after its own max-wait budget under sustained activity, leaving the row for the cron backstop", async () => {
    vi.useFakeTimers();
    try {
      const { org, clientRow, request, conversation } = await seedWaitingRequest(new Date(Date.now() + 5_000));

      const relayPromise = scheduleCaseReviewRelay({
        organizationId: org.id,
        conversationId: conversation.id,
        collectionRequestId: request.id,
        clientId: clientRow.id,
      });

      // Simulates near-continuous activity: every time the relay is about
      // to wake, push pendingCaseReviewAt further out again, well past
      // CASE_REVIEW_RELAY_MAX_WAIT_MS in total.
      let elapsed = 0;
      while (elapsed < CASE_REVIEW_RELAY_MAX_WAIT_MS + 10_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        elapsed += 5_000;
        await db
          .update(schema.conversations)
          .set({ pendingCaseReviewAt: new Date(Date.now() + 5_000) })
          .where(eq(schema.conversations.id, conversation.id));
      }
      await vi.advanceTimersByTimeAsync(5_000);

      await relayPromise;

      expect(sendTextMessage).not.toHaveBeenCalled();
      const [updated] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversation.id));
      // Left set (in the future) for scheduler.ts's own cron sweep to
      // eventually pick up — never cleared without actually reviewing.
      expect(updated.pendingCaseReviewAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
