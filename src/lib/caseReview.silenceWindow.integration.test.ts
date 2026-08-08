import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Silence-window case review (src/lib/caseReview.ts's
// runAutomaticCaseStatusReview + conversations.pendingCaseReviewAt) — an
// ordinary active collection request must never depend on the client
// typing "סיימתי": every document received pushes a 5-minute due-at
// forward, and once genuinely due, the scheduler sends exactly one
// consolidated "here's what I got / here's what's still missing" (or
// completion) message. Real DB (PGlite), real scheduler pass — only the
// WhatsApp transport and the AI provider are mocked.

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

const { runScheduledTasks } = await import("./scheduler");
const { runAutomaticCaseStatusReview, buildCaseStatusSummaryMessage, CASE_REVIEW_SILENCE_WINDOW_MS } = await import("./caseReview");

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

// Always-open business hours by default — most scenarios here are about
// the silence-window mechanism itself, not business-hours gating (covered
// separately below).
async function seedWaitingRequest(
  requirementNames: string[],
  overrides: Partial<typeof schema.organizations.$inferInsert> = {}
) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: "phone-1",
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
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
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  const requirements = [];
  for (const name of requirementNames) {
    const [req] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name, requiredCount: 1 })
      .returning();
    requirements.push(req);
  }
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id, status: "open" })
    .returning();
  return { orgId: org.id, clientId: clientRow.id, requestId: request.id, conversationId: conversation.id, requirements };
}

async function approveDocument(orgId: string, requestId: string, requirementId: string, fileName: string) {
  await db.insert(schema.documents).values({
    organizationId: orgId,
    collectionRequestId: requestId,
    requirementId,
    fileName,
    status: "approved",
  });
}

describe("buildCaseStatusSummaryMessage", () => {
  it("names both received and missing, matching the requested tone", () => {
    const message = buildCaseStatusSummaryMessage(["תעודת זהות", "רישיון נהיגה"], ["אישור שכירות"]);
    expect(message).toContain("קיבלתי את המסמכים הבאים");
    expect(message).toContain("• תעודת זהות");
    expect(message).toContain("• רישיון נהיגה");
    expect(message).toContain("עדיין חסר לי");
    expect(message).toContain("• אישור שכירות");
  });

  it("omits the received section entirely when nothing was received yet", () => {
    const message = buildCaseStatusSummaryMessage([], ["תעודת זהות"]);
    expect(message).not.toContain("קיבלתי");
    expect(message).toContain("עדיין חסר לי");
  });

  it("folds a confirmed-unsolicited 'extra' document into the received list, labeled as not-requested", () => {
    const message = buildCaseStatusSummaryMessage(
      ["תעודת זהות", "רישיון נהיגה"],
      ["אישור ניהול חשבון בנק"],
      ["קבלה על תיקון רכב — מסמך נוסף, לא נדרש במסגרת הבקשה"]
    );
    expect(message).toContain("קיבלתי את המסמכים הבאים");
    expect(message).toContain("• תעודת זהות");
    expect(message).toContain("• רישיון נהיגה");
    expect(message).toContain("• קבלה על תיקון רכב — מסמך נוסף, לא נדרש במסגרת הבקשה");
    expect(message).toContain("עדיין חסר לי");
    expect(message).toContain("• אישור ניהול חשבון בנק");
  });
});

describe("runAutomaticCaseStatusReview", () => {
  it("partial completion: sends one summary naming both received and missing requirements", async () => {
    const { orgId, requestId, conversationId, clientId, requirements } = await seedWaitingRequest([
      "תעודת זהות",
      "אישור שכירות",
    ]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("summary_sent");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("תעודת זהות");
    expect(body).toContain("אישור שכירות");
  });

  it("full completion: sends the completion message and closes the conversation", async () => {
    const { orgId, requestId, conversationId, clientId, requirements } = await seedWaitingRequest(["תעודת זהות"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("completed");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("קיבלתי הכל");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });

  it("a declined-unsolicited document (client said 'לא') never appears in the summary, either as received or missing", async () => {
    const { orgId, requestId, conversationId, clientId, requirements } = await seedWaitingRequest([
      "תעודת זהות",
      "אישור ניהול חשבון בנק",
    ]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    // Simulates applyUnsolicitedConfirmationDecision's "declined" outcome
    // (tested directly in documentIntakeReview.test.ts) — this test
    // targets caseReview.ts's own summary composition only.
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "invoice_by_mistake.pdf",
      status: "unsolicited_rejected",
    });

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("summary_sent");
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).not.toContain("invoice_by_mistake");
    expect(body).toContain("• תעודת זהות");
    expect(body).toContain("• אישור ניהול חשבון בנק");
  });

  it("a confirmed-unsolicited document folds into the summary, labeled as not-requested, without displacing what's actually still missing", async () => {
    const { orgId, requestId, conversationId, clientId, requirements } = await seedWaitingRequest([
      "תעודת זהות",
      "אישור ניהול חשבון בנק",
    ]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    // Simulates a client-confirmed unsolicited document (documentIntakeReview.ts's
    // applyUnsolicitedConfirmationDecision — tested directly in
    // documentIntakeReview.test.ts) — this test targets caseReview.ts's own
    // summary composition, independent of how the row got there.
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "קבלה על תיקון רכב.pdf",
      status: "unsolicited_approved",
    });

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("summary_sent");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("• תעודת זהות");
    expect(body).toContain("• קבלה על תיקון רכב — מסמך נוסף, לא נדרש במסגרת הבקשה");
    expect(body).toContain("עדיין חסר לי");
    expect(body).toContain("• אישור ניהול חשבון בנק");
  });

  it("completing the request with a confirmed-unsolicited document still present mentions it in the completion message", async () => {
    const { orgId, requestId, conversationId, clientId, requirements } = await seedWaitingRequest(["תעודת זהות"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "קבלה על תיקון רכב.pdf",
      status: "unsolicited_approved",
    });

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("completed");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("קיבלתי את כל המסמכים שנדרשו לבקשה");
    expect(body).toContain("• קבלה על תיקון רכב — מסמך נוסף, לא נדרש במסגרת הבקשה");
    expect(body).toContain("כל המסמכים הנדרשים התקבלו");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });

  it("a legacy stranded document_clarification row (pre-dating immediate handling) still gets asked about, and — unlike identity_anomaly/unsolicited_document — never blocks the summary from also going out in the same pass", async () => {
    // document_clarification is asked about immediately at intake time in
    // real code now (never deferred) — this row simulates a genuinely
    // legacy leftover (e.g. from before that change) purely to prove the
    // defensive backstop in runCaseReview still surfaces it rather than
    // stranding it forever. It deliberately does NOT block completion —
    // see CASE_REVIEW_RELEVANT_KINDS's own doc comment for why.
    const { orgId, requestId, conversationId, clientId } = await seedWaitingRequest(["תעודת זהות"]);
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "mystery.pdf",
      status: "clarification_requested",
      pendingFileContent: Buffer.from("bytes"),
      pendingFileMimeType: "application/pdf",
      deferredReviewKind: "document_clarification",
      deferredReviewPayload: {},
    });

    const outcome = await runAutomaticCaseStatusReview({ organizationId: orgId, collectionRequestId: requestId, conversationId, clientId });
    expect(outcome).toBe("summary_sent");
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage.mock.calls[0][2]).toContain("לא הצלחתי לזהות");
    expect(sendTextMessage.mock.calls[1][2]).toContain("תעודת זהות"); // still missing — never approved
  });
});

describe("scheduler — silence-window due-check (mandatory: debounce, then act, race-safe)", () => {
  it("does nothing while pendingCaseReviewAt is still in the future", async () => {
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    const future = new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS + 60_000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: future }).where(eq(schema.conversations.id, conversationId));

    const result = await runScheduledTasks(orgId);

    expect(result.caseStatusReviewsRun).toBe(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt!.getTime()).toBe(future.getTime());
  });

  it("once due, sends exactly one summary and clears pendingCaseReviewAt", async () => {
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות", "רישיון נהיגה"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    const past = new Date(Date.now() - 60 * 1000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: past }).where(eq(schema.conversations.id, conversationId));

    const result = await runScheduledTasks(orgId);

    expect(result.caseStatusReviewsRun).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("רישיון נהיגה");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).toBeNull();
  });

  it("a burst of several documents arriving before the window elapses still produces only one summary (batching)", async () => {
    // Simulates conversationActions.ts resetting the timer on each of
    // several documents arriving moments apart — by the time it's
    // actually due, only the LAST push matters.
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות"]);
    for (let i = 0; i < 5; i++) {
      await db
        .update(schema.conversations)
        .set({ pendingCaseReviewAt: new Date(Date.now() + CASE_REVIEW_SILENCE_WINDOW_MS) })
        .where(eq(schema.conversations.id, conversationId));
    }
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    // Now genuinely due.
    await db
      .update(schema.conversations)
      .set({ pendingCaseReviewAt: new Date(Date.now() - 1000) })
      .where(eq(schema.conversations.id, conversationId));

    const result = await runScheduledTasks(orgId);
    expect(result.caseStatusReviewsRun).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("sends the summary even while the office is closed — a direct reaction to the client's own just-happened activity, not a cold nudge, so it is never business-hours-gated (unlike the separate reminderIntervalDays reminder)", async () => {
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות"], {
      businessDays: "0,1,2,3,4",
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
    });
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    // Force a due-but-Friday instant regardless of when tests actually run.
    const friday = new Date("2026-01-16T08:00:00Z"); // Friday 10:00 local, closed (Sun-Thu only)
    await db.update(schema.conversations).set({ pendingCaseReviewAt: friday }).where(eq(schema.conversations.id, conversationId));

    const result = await runScheduledTasks(orgId);

    expect(result.caseStatusReviewsRun).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).toBeNull();
  });

  it("double-invocation of the scheduler for the same due window sends only one summary (idempotency/race safety)", async () => {
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות", "רישיון נהיגה"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    const past = new Date(Date.now() - 60 * 1000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: past }).where(eq(schema.conversations.id, conversationId));

    await Promise.all([runScheduledTasks(orgId), runScheduledTasks(orgId)]);

    expect(sendTextMessage.mock.calls.length + sendTemplateMessage.mock.calls.length).toBe(1);
  });

  it("an extension-active request is never picked up by this pass, even if pendingCaseReviewAt is somehow set", async () => {
    const { orgId, requestId, conversationId } = await seedWaitingRequest(["תעודת זהות"]);
    await db.update(schema.collectionRequests).set({ extensionActive: true }).where(eq(schema.collectionRequests.id, requestId));
    const past = new Date(Date.now() - 60 * 1000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: past }).where(eq(schema.conversations.id, conversationId));

    const result = await runScheduledTasks(orgId);

    expect(result.caseStatusReviewsRun).toBe(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("a document arriving after a summary already went out starts a fresh window and produces a second, updated summary", async () => {
    const { orgId, requestId, conversationId, requirements } = await seedWaitingRequest(["תעודת זהות", "רישיון נהיגה"]);
    await approveDocument(orgId, requestId, requirements[0].id, "id.pdf");
    const past = new Date(Date.now() - 60 * 1000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: past }).where(eq(schema.conversations.id, conversationId));

    const first = await runScheduledTasks(orgId);
    expect(first.caseStatusReviewsRun).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("רישיון נהיגה"); // still missing

    // The client sends the missing document, then goes quiet again — a
    // fresh window, exactly as conversationActions.ts would set on real
    // document receipt.
    await approveDocument(orgId, requestId, requirements[1].id, "license.pdf");
    const secondPast = new Date(Date.now() - 60 * 1000);
    await db.update(schema.conversations).set({ pendingCaseReviewAt: secondPast }).where(eq(schema.conversations.id, conversationId));

    const second = await runScheduledTasks(orgId);
    expect(second.caseStatusReviewsRun).toBe(1);
    // Second summary is the completion message, not a repeat of the first.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTextMessage.mock.calls[1][2]).toContain("קיבלתי הכל");
  });
});
