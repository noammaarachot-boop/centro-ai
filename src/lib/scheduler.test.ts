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
  // Stale enough to be due regardless of the default reminderIntervalHours.
  const staleUpdatedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "waiting_for_client",
      updatedAt: staleUpdatedAt,
      // Bug 3 remediation — the reminder-staleness clock is reminderAnchorAt,
      // never updatedAt (which an inbound message would bump); the seed must
      // set this explicitly since the schema default is "now".
      reminderAnchorAt: staleUpdatedAt,
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

// Flexible seed for the hour-granularity/defer/escalation test matrix below
// — builds on the same organization/client/service/request/conversation
// shape as seedStaleWaitingConversation, with knobs for everything those
// scenarios need to control directly instead of relying on a fixed offset.
async function seedReminderScenario(options: {
  reminderIntervalHours?: number;
  reminderIntervalHoursOverride?: number | null;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  businessDays?: string;
  reminderAnchorAt: Date;
  updatedAt?: Date;
  reviewDeadlineAt?: Date | null;
  requirementCount?: number;
  satisfiedCount?: number;
}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      businessHoursStart: options.businessHoursStart ?? "00:00",
      businessHoursEnd: options.businessHoursEnd ?? "23:59",
      businessDays: options.businessDays ?? "0,1,2,3,4,5,6",
      reminderIntervalHours: options.reminderIntervalHours ?? 5,
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 100000000)}` })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({
      organizationId: org.id,
      name: "Service",
      reminderIntervalHoursOverride: options.reminderIntervalHoursOverride ?? null,
    })
    .returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org.id,
      clientId: client.id,
      serviceId: service.id,
      periodLabel: "p",
      status: "waiting_for_client",
      reviewDeadlineAt: options.reviewDeadlineAt ?? null,
    })
    .returning();

  const requirementCount = options.requirementCount ?? 1;
  const satisfiedCount = options.satisfiedCount ?? 0;
  const requirementIds: string[] = [];
  for (let i = 0; i < requirementCount; i++) {
    const [req] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name: `מסמך ${i + 1}` })
      .returning();
    requirementIds.push(req.id);
  }
  for (let i = 0; i < satisfiedCount; i++) {
    await db.insert(schema.documents).values({
      organizationId: org.id,
      collectionRequestId: request.id,
      requirementId: requirementIds[i],
      fileName: `doc${i}.pdf`,
      status: "approved",
    });
  }

  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: "waiting_for_client",
      reminderAnchorAt: options.reminderAnchorAt,
      updatedAt: options.updatedAt ?? options.reminderAnchorAt,
    })
    .returning();

  return { orgId: org.id, requestId: request.id, conversationId: conversation.id, clientId: client.id, requirementIds };
}

describe("runScheduledTasks — reminder interval hour granularity (Bug 1)", () => {
  it("does not remind before the organization's 5-hour default has elapsed", async () => {
    const { orgId } = await seedReminderScenario({ reminderAnchorAt: new Date(Date.now() - 4 * 60 * 60 * 1000) });
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("reminds once the 5-hour default has genuinely elapsed", async () => {
    const { orgId } = await seedReminderScenario({ reminderAnchorAt: new Date(Date.now() - 5 * 60 * 60 * 1000 - 60_000) });
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("honors a per-service 7-hour override over the organization's 5-hour default", async () => {
    // 6h ago — past the 5h org default but still under the 7h override.
    const { orgId } = await seedReminderScenario({
      reminderIntervalHoursOverride: 7,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("reminds once the 7-hour override has genuinely elapsed", async () => {
    const { orgId } = await seedReminderScenario({
      reminderIntervalHoursOverride: 7,
      reminderAnchorAt: new Date(Date.now() - 7 * 60 * 60 * 1000 - 60_000),
    });
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("runScheduledTasks — business-hours defer-not-cancel (Bug 2)", () => {
  it("a reminder due while the office is closed is deferred to the next opening, never silently dropped, and leaves an audit trail", async () => {
    const friday = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local — closed (Sun-Thu businessDays)
    const { orgId, conversationId } = await seedReminderScenario({
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessDays: "0,1,2,3,4",
      reminderAnchorAt: new Date(friday.getTime() - 10 * 60 * 60 * 1000),
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(friday);
      await runScheduledTasks(orgId);
    } finally {
      vi.useRealTimers();
    }

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.deferredReminderAt).not.toBeNull();
    expect(conversation.deferredReminderAt!.getTime()).toBeGreaterThan(friday.getTime());

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "scheduler.reminder_deferred_outside_hours"), eq(schema.auditLogs.organizationId, orgId)));
    expect(auditRows).toHaveLength(1);
  });
});

describe("runScheduledTasks — reminder clock depends only on request status, never on client activity (Bug 3)", () => {
  it("a recent inbound message (bumping only updatedAt) never delays or resets a due reminder", async () => {
    const { orgId, conversationId } = await seedReminderScenario({
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000), // stale for the 5h default
    });
    // Simulate exactly what recordInboundMessage does — bump updatedAt only.
    await db.update(schema.conversations).set({ updatedAt: new Date() }).where(eq(schema.conversations.id, conversationId));

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("runScheduledTasks — 5-requirement partial-completion reminder scenario", () => {
  it("reminds naming exactly the 2 still-missing requirements (of 5), then stops reminding once all 5 are satisfied", async () => {
    const { orgId, requestId, conversationId, requirementIds } = await seedReminderScenario({
      requirementCount: 5,
      satisfiedCount: 3,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    // A recent inbound message keeps the 24h free-form session window open
    // so the reminder's real content is visible in the sent text.
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "שלחתי חלק מהמסמכים",
    });

    await runScheduledTasks(orgId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("מסמך 4");
    expect(body).toContain("מסמך 5");
    expect(body).not.toContain("מסמך 1");
    expect(body).not.toContain("מסמך 2");
    expect(body).not.toContain("מסמך 3");

    // Satisfy the remaining two, then re-run — no further reminder, request completes.
    for (const requirementId of [requirementIds[3], requirementIds[4]]) {
      await db.insert(schema.documents).values({
        organizationId: orgId,
        collectionRequestId: requestId,
        requirementId,
        fileName: "doc.pdf",
        status: "approved",
      });
    }
    sendTextMessage.mockClear();
    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");

    // A further tick still never reminds — the conversation left waiting_for_client entirely.
    sendTextMessage.mockClear();
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

describe("runScheduledTasks — human-review escalation after the 3-day completion window", () => {
  it("escalates once reviewDeadlineAt has passed — no reminder sent, a clear reason recorded, exactly once even under a concurrent double-tick", async () => {
    const { orgId, requestId } = await seedReminderScenario({
      reviewDeadlineAt: new Date(Date.now() - 60_000),
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000), // would also be a due reminder, if not escalated first
    });

    await Promise.all([runScheduledTasks(orgId), runScheduledTasks(orgId)]);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("escalated");
    expect(request.escalationReason).toContain("3 ימים");
    expect(request.reviewDeadlineAt).toBeNull();
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "collection_request.escalated"), eq(schema.auditLogs.organizationId, orgId)));
    expect(auditRows).toHaveLength(1); // never double-fired under the concurrent double-tick
  });

  it("never escalates a request that's actually already fully satisfied, even if reviewDeadlineAt is technically overdue", async () => {
    const { orgId, requestId } = await seedReminderScenario({
      requirementCount: 1,
      satisfiedCount: 1, // already fully satisfied
      reviewDeadlineAt: new Date(Date.now() - 60_000),
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed"); // not "escalated"
    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "collection_request.escalated"), eq(schema.auditLogs.organizationId, orgId)));
    expect(auditRows).toHaveLength(0);
  });

  it("a request already escalated never receives further automated activity on later ticks", async () => {
    const { orgId, requestId, conversationId } = await seedReminderScenario({
      reviewDeadlineAt: new Date(Date.now() - 60_000),
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await runScheduledTasks(orgId);
    let [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("escalated");

    // A stale conversation.updatedAt/reminderAnchorAt would normally make this
    // conversation look "due" again — but it's excluded by the scheduler's
    // own status filter now that the request is escalated.
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    sendTextMessage.mockClear();
    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).not.toHaveBeenCalled();
    expect(sendTextMessage).not.toHaveBeenCalled();
    [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("escalated"); // untouched — never reverted to the automatic track
  });
});
