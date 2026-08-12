import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { buildConversationContext } = await import("./conversationContext");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedRequest() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", documentCollectionEnabled: true })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id, requirementId: requirement.id, conversationId: conversation.id };
}

describe("buildConversationContext", () => {
  it("returns empty candidates for a fresh request with no activity", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentDocuments).toEqual([]);
    expect(context.recentResolvedConfirmations).toEqual([]);
    expect(context.openQuestion).toBeNull();
    expect(context.reviewItems).toEqual([]);
  });

  it("includes an approved document as a candidate, with its requirement name resolved", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentDocuments).toHaveLength(1);
    expect(context.recentDocuments[0].requirementName).toBe("תעודת זהות");
    expect(context.recentDocuments[0].status).toBe("approved");
  });

  it("excludes never-uploaded (rejected/declined) documents from candidates", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "extra.pdf",
      status: "unsolicited_rejected",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentDocuments).toEqual([]);
  });

  it("orders recent documents most-recent-first and respects the limit", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const base = Date.now();
    for (let i = 0; i < 7; i++) {
      await db.insert(schema.documents).values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: `doc-${i}.pdf`,
        status: "unsolicited_approved",
        receivedAt: new Date(base + i * 1000),
      });
    }
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentDocuments).toHaveLength(5); // RECENT_DOCUMENTS_LIMIT
    expect(context.recentDocuments[0].id).not.toBe(context.recentDocuments[4].id);
    const receivedTimes = context.recentDocuments.map((d) => new Date(d.receivedAt).getTime());
    expect(receivedTimes).toEqual([...receivedTimes].sort((a, b) => b - a));
  });

  it("sets openQuestion only when exactly one confirmation is pending", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: {},
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.openQuestion).not.toBeNull();
    expect(context.openQuestion?.question).toBe("האם שלחת בכוונה?");
  });

  it("includes a resolved (confirmed/declined) confirmation as a candidate, excludes still-pending ones", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values([
      {
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "identity_anomaly",
        status: "declined",
        question: "האם הוא נשלח במקום תעודת הזהות?",
        payload: { documents: [{ id: "doc-x", matchedRequirementId: null }] },
        respondedAt: new Date(),
      },
      {
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "unsolicited_document",
        status: "pending",
        question: "עוד שאלה פתוחה",
        payload: {},
      },
    ]);
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentResolvedConfirmations).toHaveLength(1);
    expect(context.recentResolvedConfirmations[0].resolvedAnswer).toBe("declined");
  });

  it("includes recent messages in chronological order, up to the widened limit", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const base = Date.now();
    await db.insert(schema.messages).values([
      { organizationId: orgId, conversationId, direction: "outbound", senderType: "ai", body: "שאלה", createdAt: new Date(base) },
      { organizationId: orgId, conversationId, direction: "inbound", senderType: "client", body: "לא", createdAt: new Date(base + 1000) },
    ]);
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.recentMessages.map((m) => m.body)).toEqual(["שאלה", "לא"]);
  });

  it("never includes another collection request's documents/confirmations, even for the same client", async () => {
    const { orgId, clientId } = await seedRequest();
    const [service] = await db.select().from(schema.services).where(eq(schema.services.organizationId, orgId));
    const [oldRequest] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "old" })
      .returning();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: oldRequest.id,
      fileName: "old-doc.pdf",
      status: "unsolicited_approved",
    });

    const [newRequest] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "new" })
      .returning();
    const [newConversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: newRequest.id })
      .returning();

    const context = await buildConversationContext({
      organizationId: orgId,
      clientId,
      collectionRequestId: newRequest.id,
      conversationId: newConversation.id,
    });
    expect(context.recentDocuments).toEqual([]);
  });

  it("includes a pending review item as a candidate, with its gist extracted from understoodContext", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "יש לי רק ספח, זה מספיק?",
      category: "alternative_or_policy_question",
      understoodContext: { relatedRequirementName: "תעודת זהות", gist: "האם ספח תעודת זהות מספיק במקום התעודה עצמה" },
      status: "pending",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.reviewItems).toHaveLength(1);
    expect(context.reviewItems[0].status).toBe("pending");
    expect(context.reviewItems[0].gist).toBe("האם ספח תעודת זהות מספיק במקום התעודה עצמה");
  });

  it("includes both pending and resolved review items, each up to their own limit", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "שאלה ישנה",
      category: "other",
      status: "resolved",
      resolutionText: "נפתר",
      resolvedBy: "employee",
      resolvedAt: new Date(),
    });
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "שאלה חדשה",
      category: "other",
      status: "pending",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    const statuses = context.reviewItems.map((r) => r.status).sort();
    expect(statuses).toEqual(["pending", "resolved"]);
  });

  it("never includes another collection request's review items, even for the same client", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [service] = await db.select().from(schema.services).where(eq(schema.services.organizationId, orgId));
    const [otherRequest] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "other" })
      .returning();
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: otherRequest.id,
      conversationId,
      clientQuestion: "שאלה מבקשה אחרת",
      category: "other",
      status: "pending",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.reviewItems).toEqual([]);
  });

  // --- Phase 1 additions (conversation-intelligence redesign) ---

  it("activeRequest describes the case itself (service, period, status, createdAt)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.activeRequest).toEqual({
      collectionRequestId: requestId,
      serviceName: "Service",
      periodLabel: "p",
      status: "draft",
      createdAt: context.activeRequest.createdAt,
    });
    expect(context.activeRequest.createdAt).not.toBe("");
  });

  it("organization surfaces name and business-hours fields", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.organization).toEqual({
      name: "Org",
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessDays: "0,1,2,3,4",
      timezone: "Asia/Jerusalem",
    });
  });

  it("otherOpenRequests lists a sibling open conversation for the same client, excludes closed ones and itself", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [service] = await db.select().from(schema.services).where(eq(schema.services.organizationId, orgId));

    const [openSibling] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "sibling" })
      .returning();
    const [openSiblingConv] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: openSibling.id, status: "open" })
      .returning();

    const [closedSibling] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: "closed-sibling" })
      .returning();
    await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId, collectionRequestId: closedSibling.id, status: "closed" });

    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.otherOpenRequests).toHaveLength(1);
    expect(context.otherOpenRequests[0].collectionRequestId).toBe(openSibling.id);
    expect(context.otherOpenRequests[0].conversationId).toBe(openSiblingConv.id);
    expect(context.otherOpenRequests[0].periodLabel).toBe("sibling");
  });

  it("recentDiscourseEntities includes the active request, real documents, and real requirements as candidates", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    const kinds = context.recentDiscourseEntities.map((e) => e.kind);
    expect(kinds).toContain("collection_request");
    expect(kinds).toContain("document");
    expect(kinds).toContain("requirement");
    expect(context.recentDiscourseEntities.find((e) => e.kind === "collection_request")?.id).toBe(requestId);
  });

  it("confirmedFocus is null when no focus row exists for this client", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.confirmedFocus).toBeNull();
  });

  it("confirmedFocus reflects a real client_conversation_focus row pointing at a still-open request", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.clientConversationFocus).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      source: "single_open_request",
    });
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.confirmedFocus).not.toBeNull();
    expect(context.confirmedFocus?.collectionRequestId).toBe(requestId);
    expect(context.confirmedFocus?.source).toBe("single_open_request");
  });

  it("confirmedFocus is null once the request it points at is completed — never trusted past staleness", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.clientConversationFocus).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      source: "explicit_switch",
    });
    await db.update(schema.collectionRequests).set({ status: "completed" }).where(eq(schema.collectionRequests.id, requestId));
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.confirmedFocus).toBeNull();
  });

  it("activePolicies surfaces only active, approved policies for this organization", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.approvedPolicies).values([
      { organizationId: orgId, questionSummary: "אפשר לשלוח צילום במקום סריקה?", decisionText: "כן, צילום ברור מספיק.", category: "other", isActive: true },
      { organizationId: orgId, questionSummary: "מדיניות ישנה", decisionText: "לא רלוונטי", category: "other", isActive: false },
    ]);
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    expect(context.activePolicies).toHaveLength(1);
    expect(context.activePolicies[0].questionSummary).toBe("אפשר לשלוח צילום במקום סריקה?");
  });
});
