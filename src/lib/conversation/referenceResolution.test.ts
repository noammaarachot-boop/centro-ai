import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Phase 2 (conversation-intelligence redesign) — proves the general
// discourse-entity reference resolver in isolation: it is NOT wired into
// route.ts/conversationDispatch.ts/classifyConversationIntent in this
// phase (that's Phase 3), so these tests call resolveConversationReference/
// confirmDurableFocus directly against real DB context
// (buildConversationContext), with the LLM call itself mocked per scenario
// — the same discipline correctionClassifier.test.ts already uses.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { buildConversationContext } = await import("./conversationContext");
const { resolveConversationReference, confirmDurableFocus } = await import("./referenceResolution");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  resolveLanguageModel.mockReset();
  resolveLanguageModel.mockResolvedValue({});
  generateObject.mockReset();
});

// Mocks a single scripted resolver response, matching resolveConversationReference's schema shape.
function mockResolution(object: Record<string, unknown>) {
  generateObject.mockResolvedValueOnce({ object });
}

async function seedOrgAndClient() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", documentCollectionEnabled: true })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  return { orgId: org.id, clientId: client.id, serviceId: service.id };
}

async function seedRequest(orgId: string, clientId: string, serviceId: string, periodLabel: string) {
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId, serviceId, periodLabel })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: orgId, clientId, collectionRequestId: request.id })
    .returning();
  return { requestId: request.id, conversationId: conversation.id };
}

describe("resolveConversationReference — item-level references (not just collection-request-level)", () => {
  it("scenario 1: 'הראשון' after 'חסרים ת\"ז ואישור הכנסה' resolves to the ת\"ז requirement, not a collection request", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [idReq] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "תעודת זהות" })
      .returning();
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "אישור הכנסה" });
    await db.insert(schema.messages).values([
      { organizationId: orgId, conversationId, direction: "outbound", senderType: "ai", body: "חסרים תעודת זהות ואישור הכנסה." },
      { organizationId: orgId, conversationId, direction: "inbound", senderType: "client", body: "את הראשון כבר שלחתי." },
    ]);

    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    mockResolution({
      status: "resolved",
      referentKind: "requirement",
      referentId: idReq.id,
      provenance: "message_explicit",
      confidence: 0.9,
      basis: "'הראשון' מתייחס לפריט הראשון שהוזכר בתשובת המערכת: תעודת זהות",
      ambiguousCandidateIds: null,
    });

    const result = await resolveConversationReference(context, "את הראשון כבר שלחתי.");
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.reference.kind).toBe("requirement");
      expect(result.reference.id).toBe(idReq.id);
      // Never a collection_request — this is exactly the historical bug
      // class (every ordinal treated as a request-disambiguation choice).
      expect(result.reference.kind).not.toBe("collection_request");
    }
  });

  it("scenario 2: confirmed focus (set via a resolved disambiguation reply) is used as the prior for a bare follow-up ('זה')", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId: request1 } = await seedRequest(orgId, clientId, serviceId, "בקשה ראשונה");
    const { requestId: request2, conversationId: conversation2 } = await seedRequest(orgId, clientId, serviceId, "בקשה שנייה");

    // Simulates what a resolved numbered disambiguation reply does today —
    // confirmDurableFocus is the only function allowed to write this.
    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: request2, source: "disambiguation_reply" });

    await db.insert(schema.messages).values([
      { organizationId: orgId, conversationId: conversation2, direction: "outbound", senderType: "ai", body: "חסרים תעודת זהות." },
      { organizationId: orgId, conversationId: conversation2, direction: "inbound", senderType: "client", body: "זה דחוף?" },
    ]);

    const context = await buildConversationContext({
      organizationId: orgId,
      clientId,
      collectionRequestId: request2,
      conversationId: conversation2,
    });
    expect(context.confirmedFocus?.collectionRequestId).toBe(request2);

    mockResolution({
      status: "resolved",
      referentKind: "collection_request",
      referentId: request2,
      provenance: "confirmed_focus",
      confidence: 0.85,
      basis: "אין אינדיקציה בהודעה לבקשה אחרת — נשען על ה-focus המאושר",
      ambiguousCandidateIds: null,
    });
    const result = await resolveConversationReference(context, "זה דחוף?");
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.reference.id).toBe(request2);
      expect(result.reference.id).not.toBe(request1);
      expect(result.reference.provenance).toBe("confirmed_focus");
    }
  });

  it("scenario 3: an explicit switch ('ומה עם הראשונה?') overrides the confirmed focus, and confirmDurableFocus persists the switch", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId: request1 } = await seedRequest(orgId, clientId, serviceId, "בקשה ראשונה");
    const { requestId: request2, conversationId: conversation2 } = await seedRequest(orgId, clientId, serviceId, "בקשה שנייה");
    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: request2, source: "disambiguation_reply" });

    const context = await buildConversationContext({
      organizationId: orgId,
      clientId,
      collectionRequestId: request2,
      conversationId: conversation2,
    });
    expect(context.confirmedFocus?.collectionRequestId).toBe(request2);

    mockResolution({
      status: "resolved",
      referentKind: "collection_request",
      referentId: request1,
      provenance: "message_explicit",
      confidence: 0.95,
      basis: "הלקוח ביקש במפורש את הבקשה הראשונה",
      ambiguousCandidateIds: null,
    });
    const result = await resolveConversationReference(context, "ומה עם הראשונה?");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved");
    expect(result.reference.id).toBe(request1);
    expect(result.reference.provenance).toBe("message_explicit");

    // A deterministic caller (not the resolver itself) decides this
    // qualifies as an explicit switch and persists it — exactly the
    // separation guardrail 3 requires (interpretation != mutation).
    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: result.reference.id, source: "explicit_switch" });

    const nextContext = await buildConversationContext({
      organizationId: orgId,
      clientId,
      collectionRequestId: request1,
      conversationId: conversation2,
    });
    expect(nextContext.confirmedFocus?.collectionRequestId).toBe(request1);
    expect(nextContext.confirmedFocus?.source).toBe("explicit_switch");
  });

  it("scenario 4: a genuinely ambiguous pronoun returns ambiguous — never a guess, no mutation", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [doc1] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.pdf", status: "unsolicited_approved" })
      .returning();
    const [doc2] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "b.pdf", status: "unsolicited_approved" })
      .returning();

    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    mockResolution({
      status: "ambiguous",
      referentKind: null,
      referentId: null,
      provenance: null,
      confidence: 0.4,
      basis: null,
      ambiguousCandidateIds: [doc1.id, doc2.id],
    });

    const result = await resolveConversationReference(context, "מה איתו?");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidateIds.sort()).toEqual([doc1.id, doc2.id].sort());
    }

    // No mutation as a side effect of resolution — real check, not an assumption.
    const [d1After] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc1.id));
    const [d2After] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc2.id));
    expect(d1After.status).toBe("unsolicited_approved");
    expect(d2After.status).toBe("unsolicited_approved");
    const focusRows = await db.select().from(schema.clientConversationFocus).where(eq(schema.clientConversationFocus.clientId, clientId));
    expect(focusRows).toEqual([]);
  });

  it("scenario 5: 'לא, התכוונתי למסמך השני' resolves to the second real document, not the first", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [doc1] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.pdf", status: "unsolicited_approved" })
      .returning();
    const [doc2] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "b.pdf", status: "unsolicited_approved" })
      .returning();

    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });
    mockResolution({
      status: "resolved",
      referentKind: "document",
      referentId: doc2.id,
      provenance: "message_explicit",
      confidence: 0.92,
      basis: "הלקוח תיקן במפורש למסמך השני",
      ambiguousCandidateIds: null,
    });

    const result = await resolveConversationReference(context, "לא, התכוונתי למסמך השני.");
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.reference.id).toBe(doc2.id);
      expect(result.reference.id).not.toBe(doc1.id);
      expect(result.reference.provenance).toBe("message_explicit");
    }
  });

  it("scenario 6: an explicit correction overrides the existing confirmed focus, and the correction (not the old focus) is what gets persisted", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId: requestA, conversationId: conversationA } = await seedRequest(orgId, clientId, serviceId, "בקשה A");
    const { requestId: requestB } = await seedRequest(orgId, clientId, serviceId, "בקשה B");
    // Focus currently points at A (e.g. from the trivial single-open-request case earlier).
    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: requestA, source: "single_open_request" });

    const context = await buildConversationContext({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestA,
      conversationId: conversationA,
    });
    expect(context.confirmedFocus?.collectionRequestId).toBe(requestA);

    mockResolution({
      status: "resolved",
      referentKind: "collection_request",
      referentId: requestB,
      provenance: "message_explicit",
      confidence: 0.93,
      basis: "הלקוח ציין במפורש שהתכוון לבקשה B, לא לזו שב-focus",
      ambiguousCandidateIds: null,
    });
    const result = await resolveConversationReference(context, "לא, שאלתי על הבקשה השנייה.");
    expect(result.status).toBe("resolved");
    if (result.status !== "resolved") throw new Error("expected resolved");
    expect(result.reference.id).toBe(requestB); // the correction wins immediately, not the stale focus
    expect(result.reference.provenance).toBe("message_explicit");

    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: result.reference.id, source: "explicit_switch" });
    const [focusRow] = await db.select().from(schema.clientConversationFocus).where(eq(schema.clientConversationFocus.clientId, clientId));
    expect(focusRow.collectionRequestId).toBe(requestB);
    expect(focusRow.source).toBe("explicit_switch");
  });

  it("never trusts a hallucinated id — an id outside the real candidate set degrades to ambiguous, never acted on", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const context = await buildConversationContext({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId });

    mockResolution({
      status: "resolved",
      referentKind: "document",
      referentId: "00000000-0000-0000-0000-000000000000", // not a real row
      provenance: "message_explicit",
      confidence: 0.99,
      basis: "irrelevant",
      ambiguousCandidateIds: null,
    });

    const result = await resolveConversationReference(context, "את זה כבר שלחתי");
    expect(result.status).toBe("ambiguous");
  });

  it("confirmDurableFocus upserts — a second call for the same client overwrites the first, never leaves two rows", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId: request1 } = await seedRequest(orgId, clientId, serviceId, "p1");
    const { requestId: request2 } = await seedRequest(orgId, clientId, serviceId, "p2");

    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: request1, source: "single_open_request" });
    await confirmDurableFocus({ organizationId: orgId, clientId, collectionRequestId: request2, source: "disambiguation_reply" });

    const rows = await db.select().from(schema.clientConversationFocus).where(eq(schema.clientConversationFocus.clientId, clientId));
    expect(rows).toHaveLength(1);
    expect(rows[0].collectionRequestId).toBe(request2);
    expect(rows[0].source).toBe("disambiguation_reply");
  });
});
