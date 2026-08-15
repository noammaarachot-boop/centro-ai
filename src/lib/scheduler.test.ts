import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { WhatsAppSendError } from "@/lib/whatsapp/send";

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
  // Root-cause fix coverage — defaults preserve every existing test's
  // waiting_for_client/waiting_for_client shape unchanged. Pass "active"/
  // "open" to seed the never-left-open-active scenario the reminder pass
  // was widened to cover.
  requestStatus?: "waiting_for_client" | "active";
  conversationStatus?: "waiting_for_client" | "open";
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
      status: options.requestStatus ?? "waiting_for_client",
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
      status: options.conversationStatus ?? "waiting_for_client",
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

// Root-cause fix (2026-08-15 production incident) — a request that never
// once had every requirement satisfied never left status=active/open
// (evaluateAndPrompt's own completion gate never promotes it to
// waiting_for_client), so it never reached the reminder pass at all. These
// scenarios use requestStatus:"active"/conversationStatus:"open" — the
// state every real stuck production request was actually found in.
describe("runScheduledTasks — root-cause fix: reminders for a request that never left status=active/open", () => {
  it("A. no documents received at all — reminder is sent once due", async () => {
    const { orgId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 1,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("B. only some of the required documents received — reminder is still sent", async () => {
    const { orgId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 3,
      satisfiedCount: 1,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("C. every required document already received — no reminder (the missing-items nudge), request completes instead", async () => {
    const { orgId, requestId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 1,
      satisfiedCount: 1,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);

    // This exact scenario (already satisfied AND already idle past
    // inactivityTimeoutMinutes when first observed) also crosses paths with
    // the pre-existing idleOpenConversations pass, which legitimately owns
    // sending the one-time "thank you" (centro_thank_you_confirm) the
    // moment a still-open conversation is found satisfied — expected, and
    // not the missing-items reminder this test is actually about. What
    // matters here: the missing-items template (centro_thank_you_confirm's
    // sibling, never this one) is never sent, and the request completes.
    const templateNames = sendTemplateMessage.mock.calls.map((call) => call[2]);
    expect(templateNames).not.toContain("centro_reminder");
    expect(templateNames).not.toContain("centro_reminder_v2");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
  });

  it("D. reminder content names every currently-missing item when nothing was received", async () => {
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 2,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    // A recent inbound message keeps the 24h free-form session window open
    // so the reminder's real dynamic content is visible as plain text.
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "שלום",
    });

    await runScheduledTasks(orgId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("מסמך 1");
    expect(body).toContain("מסמך 2");
  });

  it("E. partial completion — reminder content names only the remaining missing items", async () => {
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 3,
      satisfiedCount: 1,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "שלום",
    });

    await runScheduledTasks(orgId);

    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).not.toContain("מסמך 1"); // already satisfied
    expect(body).toContain("מסמך 2");
    expect(body).toContain("מסמך 3");
  });

  it("F. a document completed after a previous reminder no longer appears in the next one", async () => {
    const { orgId, requestId, conversationId, requirementIds } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 2,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "שלום",
    });

    await runScheduledTasks(orgId);
    const firstBody = sendTextMessage.mock.calls[0][2] as string;
    expect(firstBody).toContain("מסמך 1");
    expect(firstBody).toContain("מסמך 2");

    // The client sends the first document, then another full interval
    // passes before the second reminder is due.
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirementIds[0],
      fileName: "doc.pdf",
      status: "approved",
    });
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    sendTextMessage.mockClear();

    await runScheduledTasks(orgId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const secondBody = sendTextMessage.mock.calls[0][2] as string;
    expect(secondBody).not.toContain("מסמך 1"); // already completed — never re-mentioned
    expect(secondBody).toContain("מסמך 2");
  });

  it("G. a rejected (not approved) document still counts as missing — never silently treated as satisfied", async () => {
    const { orgId, requestId, requirementIds } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 1,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirementIds[0],
      fileName: "doc.pdf",
      status: "rejected",
    });

    await runScheduledTasks(orgId);

    // Still due for a reminder — a rejected document never satisfies its requirement.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("G2. the reminder text itself distinguishes never-received from received-but-rejected/needs_review — plain wording, no exposed status names", async () => {
    const { orgId, conversationId, requestId, requirementIds } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 3,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    // מסמך 1 — never received (left alone).
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirementIds[1],
      fileName: "doc2.pdf",
      status: "rejected",
    });
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirementIds[2],
      fileName: "doc3.pdf",
      status: "needs_review",
    });
    // A recent inbound message opens the free-form window so the real
    // dynamic text (not just the template call) is directly inspectable.
    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      senderType: "client",
      body: "שלום",
    });

    await runScheduledTasks(orgId);

    // The freeform reminder body is a single comma-joined line (not
    // bullets), so each item's own text — including any attention suffix —
    // is checked as one contiguous substring, never assuming line breaks.
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("מסמך 1"); // never received
    expect(body).toContain("מסמך 2 — "); // rejected — named AND flagged
    expect(body).toContain("מסמך 3 — "); // needs_review — named AND flagged, same phrasing
    // The never-received item must not carry the attention phrase.
    expect(body).not.toContain("מסמך 1 — ");
    // Never a technical status name anywhere in the client-facing text.
    expect(body).not.toContain("rejected");
    expect(body).not.toContain("needs_review");
    expect(body).not.toContain("processing");
  });

  it("R/S. a request stuck for days (real production shape) becomes eligible immediately on recovery, using its real historical anchor — never resets to now", async () => {
    const fiveDaysAgo = new Date(Date.now() - 116 * 60 * 60 * 1000); // matches the real stuck production request's age
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 1,
      satisfiedCount: 0,
      reminderAnchorAt: fiveDaysAgo,
    });

    const before = Date.now();
    await runScheduledTasks(orgId);

    // Sent on the very first tick after the fix — never had to wait another
    // full reminderIntervalHours from "now" just because recovery happened now.
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // The anchor advances to the moment of this real send (starting the next
    // cycle from here) — it does not retroactively rewrite history either.
    expect(conversation.reminderAnchorAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("T. a partially-completed request keeps receiving reminder cycles until it's genuinely complete", async () => {
    const { orgId, requestId, conversationId, requirementIds } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 2,
      satisfiedCount: 0,
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);

    // Still incomplete — simulate another full interval elapsing.
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1); // a second cycle, not silently stopped

    // Now genuinely complete — reminders stop for good. Also idle again
    // (real elapsed time, not just the reminder cycle) so
    // idleOpenConversations — the sole owner of completing a still-"open"
    // conversation, see the widened branch's own doc comment — actually
    // reaches it on this tick too.
    await db.insert(schema.documents).values([
      { organizationId: orgId, collectionRequestId: requestId, requirementId: requirementIds[0], fileName: "a.pdf", status: "approved" },
      { organizationId: orgId, collectionRequestId: requestId, requirementId: requirementIds[1], fileName: "b.pdf", status: "approved" },
    ]);
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000), updatedAt: new Date(Date.now() - 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);

    const templateNames = sendTemplateMessage.mock.calls.map((call) => call[2]);
    expect(templateNames).not.toContain("centro_reminder");
    expect(templateNames).not.toContain("centro_reminder_v2");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });

  it("U. completion is re-checked immediately before sending — a request that became complete is never nagged even though its anchor looks overdue", async () => {
    const { orgId, requestId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      requirementCount: 1,
      satisfiedCount: 1, // already fully satisfied by the time the tick runs
      reminderAnchorAt: new Date(Date.now() - 48 * 60 * 60 * 1000), // very overdue by anchor alone
    });

    await runScheduledTasks(orgId);

    // Same idleOpenConversations/staleWaiting crossover as test "C" above —
    // what actually matters: no missing-items reminder template, and completion.
    const templateNames = sendTemplateMessage.mock.calls.map((call) => call[2]);
    expect(templateNames).not.toContain("centro_reminder");
    expect(templateNames).not.toContain("centro_reminder_v2");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });
});

describe("runScheduledTasks — root-cause fix: reminderIntervalHours boundaries (H/I/J), also for the active/open branch", () => {
  it("H. a 1-hour interval is respected: not due at 50 minutes, due at 61 minutes", async () => {
    const notDue = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderIntervalHours: 1,
      reminderAnchorAt: new Date(Date.now() - 50 * 60 * 1000),
    });
    await runScheduledTasks(notDue.orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();

    const due = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderIntervalHours: 1,
      reminderAnchorAt: new Date(Date.now() - 61 * 60 * 1000),
    });
    await runScheduledTasks(due.orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("I. the 5-hour default is respected for the active/open branch specifically", async () => {
    const notDue = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderAnchorAt: new Date(Date.now() - 4 * 60 * 60 * 1000 - 59 * 60 * 1000),
    });
    await runScheduledTasks(notDue.orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();

    const due = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderAnchorAt: new Date(Date.now() - 5 * 60 * 60 * 1000 - 60_000),
    });
    await runScheduledTasks(due.orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("J. a 24-hour interval (the maximum) is respected", async () => {
    const notDue = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderIntervalHours: 24,
      reminderAnchorAt: new Date(Date.now() - 23 * 60 * 60 * 1000 - 59 * 60 * 1000),
    });
    await runScheduledTasks(notDue.orgId);
    expect(sendTemplateMessage).not.toHaveBeenCalled();

    const due = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderIntervalHours: 24,
      reminderAnchorAt: new Date(Date.now() - 24 * 60 * 60 * 1000 - 60_000),
    });
    await runScheduledTasks(due.orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});

describe("runScheduledTasks — root-cause fix: business hours/days for the active/open branch (L/M/N)", () => {
  it("L/N. due while closed (Friday, a non-working day) — not sent then, deferred to the next real opening, never lost", async () => {
    const friday = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local — closed (Sun-Thu businessDays)
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
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
    // Postponed past the closed Fri/Sat weekend to Sunday's opening, not lost.
    const deferredParts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Jerusalem", weekday: "short" }).format(
      conversation.deferredReminderAt!
    );
    expect(deferredParts).toBe("Sun");
  });

  it("M. once the deferred window genuinely opens, and the request is still incomplete, the reminder is actually sent", async () => {
    const friday = new Date("2026-01-16T08:00:00Z");
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessDays: "0,1,2,3,4",
      reminderAnchorAt: new Date(friday.getTime() - 10 * 60 * 60 * 1000),
    });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(friday);
      await runScheduledTasks(orgId);
      const [afterDefer] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
      expect(afterDefer.deferredReminderAt).not.toBeNull();

      vi.setSystemTime(new Date(afterDefer.deferredReminderAt!.getTime() + 60_000)); // just after the window opens
      await runScheduledTasks(orgId);
    } finally {
      vi.useRealTimers();
    }

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(after.deferredReminderAt).toBeNull();
  });
});

describe("runScheduledTasks — root-cause fix: reminder cycle correctness (O/P/Q)", () => {
  it("O. a successful reminder advances the cycle: no immediate re-send, but a genuine second interval later sends again (periodic, not one-shot)", async () => {
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
    const [afterFirst] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId); // immediately again — must not re-send
    expect(sendTemplateMessage).not.toHaveBeenCalled();

    // A full interval genuinely passes.
    await db
      .update(schema.conversations)
      .set({ reminderAnchorAt: new Date(afterFirst.reminderAnchorAt.getTime() - 6 * 60 * 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    sendTemplateMessage.mockClear();
    await runScheduledTasks(orgId);
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1); // the recurring second reminder
  });

  it('P. Meta reports sent:true but deliveryStatus:"failed" — never treated as a successful reminder, never loses the cycle, safe retry with no duplicate send', async () => {
    const { orgId, conversationId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });
    const [before] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    // sendOutboundMessage's own real (unmocked) contract: a genuine Meta
    // rejection (WhatsAppSendError, thrown from the transport layer this
    // test mocks) is caught inside sendViaWhatsApp and surfaces as
    // { sent: true, deliveryStatus: "failed" } — sent:true because the
    // automation gate itself did allow the attempt, deliveryStatus:"failed"
    // because Meta rejected it. This is the exact shape the scheduler must
    // not misread as success.
    sendTemplateMessage.mockRejectedValueOnce(new WhatsAppSendError("simulated Meta rejection"));
    const result = await runScheduledTasks(orgId);

    expect(result.reminded).toBe(0);
    const [afterFailure] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // Restored to the original anchor — the failed attempt never consumed the cycle.
    expect(afterFailure.reminderAnchorAt.getTime()).toBe(before.reminderAnchorAt.getTime());

    // The real persisted message row (sendOutboundMessage's own "pending"
    // row, finalized after the transport call) proves deliveryStatus was
    // genuinely "failed" — not inferred from the mock, from the database
    // sendOutboundMessage itself wrote to.
    const messageRows = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(messageRows).toHaveLength(1);
    expect(messageRows[0].deliveryStatus).toBe("failed");
    expect(messageRows[0].whatsappMessageId).toBeNull();

    const failedAudit = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "scheduler.reminder_send_failed"), eq(schema.auditLogs.organizationId, orgId)));
    expect(failedAudit).toHaveLength(1);
    expect(failedAudit[0].description).toContain("failed"); // names the real deliveryStatus, not a generic message
    const sentAudit = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "scheduler.reminder_sent"), eq(schema.auditLogs.organizationId, orgId)));
    expect(sentAudit).toHaveLength(0); // never logged as a successful send

    // Retried on the very next tick (still due, nothing consumed) — this
    // time Meta genuinely accepts it, and it succeeds exactly once — no
    // duplicate of the failed attempt, no second real send beyond this one.
    sendTemplateMessage.mockResolvedValueOnce({ messageId: "wamid.out" });
    const secondResult = await runScheduledTasks(orgId);
    expect(secondResult.reminded).toBe(1);
    const secondSentAudit = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.eventType, "scheduler.reminder_sent"), eq(schema.auditLogs.organizationId, orgId)));
    expect(secondSentAudit).toHaveLength(1); // exactly one genuine success, ever, for this cycle
    expect(sendTemplateMessage).toHaveBeenCalledTimes(2); // one failed attempt, one real send — never duplicated beyond that
  });

  it("Q. two concurrent cron ticks on the same due request never produce two reminders", async () => {
    const { orgId } = await seedReminderScenario({
      requestStatus: "active",
      conversationStatus: "open",
      reminderAnchorAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    });

    await Promise.all([runScheduledTasks(orgId), runScheduledTasks(orgId)]);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });
});
