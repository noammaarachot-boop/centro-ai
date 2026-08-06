import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Post-completion extension flow (mandatory scenarios #7-#11): a client
// adding documents after a completed request is never assumed to be done
// after the first upload — only an explicit "finished" signal, or the
// extension-finished-check confirmation, closes the request again.

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

const {
  createExtensionFinishedCheckIfDue,
  withdrawStaleFinishedCheck,
  applyExtensionFinishedDecision,
  EXTENSION_NUDGE_AFTER_MINUTES,
} = await import("./requestExtension");
const { resolveConfirmationFromReply, listOpenConfirmationsForCollectionRequest } = await import("./pendingConfirmations");
const { runScheduledTasks } = await import("./scheduler");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
});

async function seedActiveExtensionRequest(conversationUpdatedAt: Date) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: "phone-1",
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
    })
    .returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org.id,
      clientId: clientRow.id,
      serviceId: service.id,
      periodLabel: "p",
      status: "active",
      extensionActive: true,
    })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: clientRow.id,
      collectionRequestId: request.id,
      status: "open",
      updatedAt: conversationUpdatedAt,
    })
    .returning();
  return { orgId: org.id, clientId: clientRow.id, requestId: request.id, conversationId: conversation.id };
}

describe("mandatory #8: uploaded a document but never said 'finished' -> nudged after inactivity", () => {
  it("runScheduledTasks asks 'סיימת להעלות?' once the conversation has been quiet past the threshold", async () => {
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, requestId } = await seedActiveExtensionRequest(staleTime);

    await runScheduledTasks(orgId);

    const open = await listOpenConfirmationsForCollectionRequest(requestId);
    expect(open).toHaveLength(1);
    expect(open[0].kind).toBe("extension_finished_check");
  });

  it("does not nudge yet while still within the inactivity threshold", async () => {
    const recentTime = new Date(Date.now() - 5 * 60 * 1000);
    const { orgId, requestId } = await seedActiveExtensionRequest(recentTime);

    await runScheduledTasks(orgId);

    const open = await listOpenConfirmationsForCollectionRequest(requestId);
    expect(open).toHaveLength(0);
  });

  it("never asks twice — a second scheduler tick is a no-op while the question is still open", async () => {
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, requestId } = await seedActiveExtensionRequest(staleTime);

    await runScheduledTasks(orgId);
    await runScheduledTasks(orgId);

    const open = await listOpenConfirmationsForCollectionRequest(requestId);
    expect(open).toHaveLength(1);
  });
});

describe("mandatory #9: client chooses 'לא, יש עוד' -> extension stays open", () => {
  it("declining just acknowledges — no state change, extensionActive stays true", async () => {
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, clientId, requestId, conversationId } = await seedActiveExtensionRequest(staleTime);

    await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    const resolved = await resolveConfirmationFromReply(conversationId, "לא, עוד רגע");
    expect(resolved!.status).toBe("declined");
    await applyExtensionFinishedDecision(resolved!);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.extensionActive).toBe(true);
    expect(request.status).toBe("active");
  });
});

describe("mandatory #10: client chooses 'כן, סיימתי' -> case review + completion", () => {
  it("confirming runs the normal finish pipeline and clears extensionActive", async () => {
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, clientId, requestId, conversationId } = await seedActiveExtensionRequest(staleTime);

    await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    const resolved = await resolveConfirmationFromReply(conversationId, "כן");
    expect(resolved!.status).toBe("confirmed");
    await applyExtensionFinishedDecision(resolved!);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    expect(request.extensionActive).toBe(false);
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
  });
});

describe("mandatory #11: no reply to the finished-check -> reminders, then escalation to an employee", () => {
  it("reuses the existing generic reminder/escalation cron pass — no separate logic path", async () => {
    const { sendConfirmationRemindersAndEscalate } = await import("./documentIntakeReview");
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, clientId, requestId } = await seedActiveExtensionRequest(staleTime);
    await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });

    // Simulate having already exhausted the organization's default max
    // reminders (2), due right now.
    const [open] = await listOpenConfirmationsForCollectionRequest(requestId);
    await db
      .update(schema.pendingConfirmations)
      .set({ remindersSent: 2, nextReminderAt: new Date() })
      .where(eq(schema.pendingConfirmations.id, open.id));

    const { escalated } = await sendConfirmationRemindersAndEscalate(orgId);
    expect(escalated).toBe(1);

    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.id, open.id));
    expect(row.escalatedAt).not.toBeNull();

    const auditRows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows.some((r) => r.eventType === "pending_confirmation.escalated_no_reply")).toBe(true);
  });
});

describe("withdrawStaleFinishedCheck: new activity supersedes an open question", () => {
  it("silently declines the open extension_finished_check without sending a message", async () => {
    const staleTime = new Date(Date.now() - (EXTENSION_NUDGE_AFTER_MINUTES + 5) * 60 * 1000);
    const { orgId, clientId, requestId } = await seedActiveExtensionRequest(staleTime);
    await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    expect(await listOpenConfirmationsForCollectionRequest(requestId)).toHaveLength(1);

    sendTextMessage.mockClear();
    await withdrawStaleFinishedCheck(requestId);

    expect(await listOpenConfirmationsForCollectionRequest(requestId)).toHaveLength(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
