import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return { ...actual, sendTextMessage: (...args: unknown[]) => sendTextMessage(...args), sendTemplateMessage: vi.fn(), sendInteractiveButtonsMessage: vi.fn() };
});

const matchClientQuestionToPolicy = vi.fn();
const renderPolicyAnswer = vi.fn();
const listActivePolicies = vi.fn();
vi.mock("@/lib/policyKnowledgeBase", () => ({
  matchClientQuestionToPolicy: (...args: unknown[]) => matchClientQuestionToPolicy(...args),
  renderPolicyAnswer: (...args: unknown[]) => renderPolicyAnswer(...args),
  listActivePolicies: (...args: unknown[]) => listActivePolicies(...args),
}));

const { handlePotentialReviewQuestion, resolveEmployeeReviewItem, closeReviewItemFromClientContext, addContextNoteToReviewItem } = await import("./employeeReview");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  matchClientQuestionToPolicy.mockReset();
  renderPolicyAnswer.mockReset();
  listActivePolicies.mockReset();
  listActivePolicies.mockResolvedValue([]);
});

async function seedRequest() {
  const [org] = await db
    .insert(schema.organizations)
    // Suffixed with a fresh uuid — Phase 1.6's unique constraint on this
    // column (see caseReview.test.ts's identical comment).
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`, documentCollectionEnabled: true })
    .returning();
  const [client] = await db.insert(schema.clients).values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" }).returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db.insert(schema.collectionRequests).values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" }).returning();
  const [conversation] = await db.insert(schema.conversations).values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id }).returning();
  const [user] = await db.insert(schema.users).values({ organizationId: org.id, email: `u${Date.now()}@example.com`, passwordHash: "x", fullName: "עובד" }).returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id, conversationId: conversation.id, userId: user.id };
}

describe("handlePotentialReviewQuestion", () => {
  it("a matching approved policy answers immediately — no review item created, no waiting", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    listActivePolicies.mockResolvedValueOnce([{ id: "policy-1", questionSummary: "..." }]);
    matchClientQuestionToPolicy.mockResolvedValueOnce({ policyId: "policy-1", confidence: 0.9 });
    renderPolicyAnswer.mockResolvedValueOnce("כן, אפשר לשלוח דרכון במקום.");

    const result = await handlePotentialReviewQuestion({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "אפשר דרכון במקום ת.ז?",
      category: "alternative_or_policy_question",
      relatedRequirementId: null,
    });

    expect(result.outcome).toBe("answered_by_policy");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("דרכון");
    const items = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(items).toHaveLength(0);
  });

  it("no matching policy -> opens a review item, replies immediately with the fixed wording, never blocks", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    matchClientQuestionToPolicy.mockResolvedValueOnce({ policyId: null, confidence: 0 });

    const result = await handlePotentialReviewQuestion({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "יש לי רק צילום של המסמך, זה מספיק?",
      category: "alternative_or_policy_question",
      relatedRequirementId: null,
      understoodContext: { relatedRequirementName: null, gist: "שאלה על צילום מול סריקה" },
    });

    expect(result.outcome).toBe("opened_review_item");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toBe("העברתי את השאלה לבדיקה מול המשרד ואעדכן אותך כשאקבל תשובה.");
    const [item] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(item.status).toBe("pending");
    expect(item.clientQuestion).toContain("צילום");
  });
});

describe("resolveEmployeeReviewItem", () => {
  it("resolves without promoting to policy by default — the answer is case-specific only", async () => {
    const { orgId, clientId, requestId, conversationId, userId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "שאלה", category: "other", status: "pending" })
      .returning();

    const result = await resolveEmployeeReviewItem({
      organizationId: orgId,
      actorUserId: userId,
      reviewItemId: item.id,
      resolutionText: "כן, זה בסדר במקרה הזה.",
      promoteToPolicy: false,
    });

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved");
    expect(after.becamePolicy).toBe(false);
    expect(after.policyId).toBeNull();
    const policies = await db.select().from(schema.approvedPolicies).where(eq(schema.approvedPolicies.organizationId, orgId));
    expect(policies).toHaveLength(0);
    expect(sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "כן, זה בסדר במקרה הזה.", undefined);
  });

  it("explicit opt-in creates a real, immediately-matchable policy", async () => {
    const { orgId, clientId, requestId, conversationId, userId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "אפשר דרכון במקום ת.ז?", category: "alternative_or_policy_question", status: "pending" })
      .returning();

    const result = await resolveEmployeeReviewItem({
      organizationId: orgId,
      actorUserId: userId,
      reviewItemId: item.id,
      resolutionText: "כן, דרכון תקף מתקבל.",
      promoteToPolicy: true,
    });

    expect(result.ok).toBe(true);
    const [policy] = await db.select().from(schema.approvedPolicies).where(eq(schema.approvedPolicies.organizationId, orgId));
    expect(policy.decisionText).toBe("כן, דרכון תקף מתקבל.");
    expect(policy.sourceReviewItemId).toBe(item.id);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.becamePolicy).toBe(true);
    expect(after.policyId).toBe(policy.id);
  });

  it("already-resolved item cannot be resolved twice", async () => {
    const { orgId, clientId, requestId, conversationId, userId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "שאלה", category: "other", status: "resolved" })
      .returning();
    const result = await resolveEmployeeReviewItem({ organizationId: orgId, actorUserId: userId, reviewItemId: item.id, resolutionText: "תשובה", promoteToPolicy: false });
    expect(result.ok).toBe(false);
  });
});

describe("closeReviewItemFromClientContext", () => {
  it("closes a pending item with a clear ai_context audit trail, sends the natural acknowledgment to the client", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "יש לי רק ספח, זה מספיק?", category: "alternative_or_policy_question", status: "pending" })
      .returning();

    const result = await closeReviewItemFromClientContext({
      organizationId: orgId,
      reviewItemId: item.id,
      triggerMessage: "לא משנה, מצאתי את תעודת הזהות ואני שולח אותה",
      reason: "הלקוח מצא את תעודת הזהות המקורית, השאלה על הספח כבר לא רלוונטית.",
      clientAcknowledgment: "מעולה, אפשר לשלוח אותה כאן.",
    });

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved");
    expect(after.resolvedBy).toBe("ai_context");
    expect(after.resolvedByUserId).toBeNull();
    expect(after.resolutionText).toContain("ספח");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "מעולה, אפשר לשלוח אותה כאן.", undefined);
  });

  it("an already-resolved item cannot be closed again", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "שאלה", category: "other", status: "resolved" })
      .returning();
    const result = await closeReviewItemFromClientContext({
      organizationId: orgId,
      reviewItemId: item.id,
      triggerMessage: "משהו",
      reason: "משהו",
      clientAcknowledgment: "תודה",
    });
    expect(result.ok).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

describe("addContextNoteToReviewItem", () => {
  it("appends an additive note without touching the original clientQuestion, sends the acknowledgment", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, clientQuestion: "יש לי רק ספח, זה מספיק?", category: "alternative_or_policy_question", status: "pending" })
      .returning();

    const result = await addContextNoteToReviewItem({
      organizationId: orgId,
      reviewItemId: item.id,
      triggerMessage: "דרך אגב יש לי גם תעודה ישנה שפג תוקפה, זה משנה משהו?",
      note: "הלקוח ציין שיש ברשותו גם תעודה ישנה שפג תוקפה.",
      clientAcknowledgment: "תודה, רשמתי את זה.",
    });

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("pending"); // never closes on its own
    expect(after.clientQuestion).toBe("יש לי רק ספח, זה מספיק?"); // never rewritten
    const updates = after.contextUpdates as Array<{ note: string; clientMessage: string; at: string }>;
    expect(updates).toHaveLength(1);
    expect(updates[0].note).toContain("פג תוקפה");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "תודה, רשמתי את זה.", undefined);
  });

  it("can add a note to an already-resolved item too, purely for the record", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        clientQuestion: "שאלה",
        category: "other",
        status: "resolved",
        resolutionText: "כן",
        resolvedBy: "employee",
        resolvedAt: new Date(),
      })
      .returning();

    const result = await addContextNoteToReviewItem({
      organizationId: orgId,
      reviewItemId: item.id,
      triggerMessage: "תודה על התשובה",
      note: "הלקוח אישר קבלת התשובה",
      clientAcknowledgment: "בשמחה!",
    });

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved"); // untouched
  });

  it("appends to existing context updates rather than overwriting them", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        clientQuestion: "שאלה",
        category: "other",
        status: "pending",
        contextUpdates: [{ note: "פרט ראשון", clientMessage: "הודעה 1", at: new Date().toISOString() }],
      })
      .returning();

    await addContextNoteToReviewItem({
      organizationId: orgId,
      reviewItemId: item.id,
      triggerMessage: "הודעה 2",
      note: "פרט שני",
      clientAcknowledgment: "תודה",
    });

    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    const updates = after.contextUpdates as Array<{ note: string }>;
    expect(updates.map((u) => u.note)).toEqual(["פרט ראשון", "פרט שני"]);
  });
});
