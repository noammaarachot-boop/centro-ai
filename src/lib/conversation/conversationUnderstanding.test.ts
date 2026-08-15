import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Phase 3 (conversation-intelligence redesign) — proves the general
// reasoning layer (ACT/ANSWER/CLARIFY/ESCALATE/UNRELATED) end to end, in
// isolation: understandConversationTurn is called directly (matching how
// Phase 2's referenceResolution.test.ts already does this), NOT through
// route.ts/conversationDispatch.ts — those are untouched in this phase and
// keep running classifyConversationIntent exactly as before. The LLM calls
// themselves (reference resolution, reasoning, grounded-answer composition,
// policy matching) are mocked per scenario, same discipline as every other
// AI-calling test in this codebase.

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
    sendInteractiveButtonsMessage: vi.fn().mockResolvedValue({ messageId: "wamid.out" }),
    sendTemplateMessage: vi.fn(),
  };
});

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
const generateText = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  generateText: (...args: unknown[]) => generateText(...args),
}));

const { understandConversationTurn } = await import("./conversationUnderstanding");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  resolveLanguageModel.mockReset();
  resolveLanguageModel.mockResolvedValue({});
  generateObject.mockReset();
  generateText.mockReset();
});

const NO_REFERENCE = { status: "no_reference" };

function mockObjectSequence(...objects: Record<string, unknown>[]) {
  for (const object of objects) generateObject.mockResolvedValueOnce({ object });
}

function mockText(text: string) {
  generateText.mockResolvedValueOnce({ text });
}

async function seedOrgAndClient() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", documentCollectionEnabled: true, whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
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

describe("understandConversationTurn — Phase 3 general reasoning outcomes", () => {
  it("1: a brand-new question with no matching enum/category still gets ANSWER when grounded in a real fact", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [req] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "אישור ניהול חשבון בנק" })
      .returning();

    mockObjectSequence(
      NO_REFERENCE, // reference resolution
      { outcome: "ANSWER", confidence: 0.9, answerGroundedOn: [req.id] }
    );
    mockText("אישור ניהול חשבון בנק עדיין לא התקבל אצלנו.");

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "אפשר לשלוח את זה גם דרך אתר הבנק ישירות?", // a genuinely novel phrasing, not in any enum
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("אישור ניהול חשבון בנק");

    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toEqual([]); // never escalated — answered directly
  });

  it("2: no verified information in the system -> honest 'no data' answer, not hallucination, not automatic ESCALATE", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ANSWER", confidence: 0.7, answerGroundedOn: [] } // nothing relevant known
    );
    mockText("אין לי כרגע מידע מאומת שעונה על השאלה הזו — אבדוק ואחזור אליך.");

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "יש לכם חניה במשרד?",
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toContain("אין לי כרגע מידע מאומת");
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toEqual([]); // honest "don't know" is not a reason to escalate
  });

  it("3: reference ambiguous AND the referent is necessary for the action -> CLARIFY, no mutation", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [doc1] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.pdf", status: "unsolicited_approved" }).returning();
    const [doc2] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "b.pdf", status: "unsolicited_approved" }).returning();

    mockObjectSequence(
      { status: "ambiguous", referentKind: null, referentId: null, provenance: null, confidence: 0.4, basis: null, ambiguousCandidateIds: [doc1.id, doc2.id] },
      {
        outcome: "CLARIFY",
        confidence: 0.5,
        clarifyQuestion: "לאיזה מהמסמכים האחרונים שלך זה מתייחס?",
        clarifyMissing: "which document 'it' refers to",
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "את זה כבר שלחתי",
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toBe("לאיזה מהמסמכים האחרונים שלך זה מתייחס?");
    const [d1] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc1.id));
    const [d2] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc2.id));
    expect(d1.status).toBe("unsolicited_approved");
    expect(d2.status).toBe("unsolicited_approved");
  });

  it("4: reference ambiguous BUT not required to answer -> no unnecessary CLARIFY, answers directly", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "תעודת זהות" });

    mockObjectSequence(
      { status: "ambiguous", referentKind: null, referentId: null, provenance: null, confidence: 0.4, basis: null, ambiguousCandidateIds: ["irrelevant-1", "irrelevant-2"] },
      { outcome: "ANSWER", confidence: 0.85, answerGroundedOn: ["active_request"] }
    );
    mockText("הבקשה שלך עדיין פתוחה, לא הושלמה.");

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "מה המצב של הבקשה שלי בכלל?",
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toBe("הבקשה שלך עדיין פתוחה, לא הושלמה.");
  });

  it("5: a genuine need for human judgment -> ESCALATE, real review item created", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    // No approved_policies rows seeded -> handlePotentialReviewQuestion's
    // policy-match step short-circuits without its own AI call.

    mockObjectSequence(
      NO_REFERENCE,
      {
        outcome: "ESCALATE",
        confidence: 0.8,
        escalateCategory: "alternative_or_policy_question",
        escalateGist: "האם אפשר להגיש מסמך על שם קרוב משפחה במקום",
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "אפשר שאבא שלי יגיש במקומי?",
    });
    expect(result.handled).toBe(true);
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toHaveLength(1);
    expect(reviewItems[0].status).toBe("pending");
    expect(reviewItems[0].clientQuestion).toBe("אפשר שאבא שלי יגיש במקומי?");
  });

  it("6: unfamiliar phrasing that IS answerable from context -> ANSWER, never ESCALATE just because the wording is unrecognized", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "ייפוי כוח" });

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ANSWER", confidence: 0.88, answerGroundedOn: ["organization"] }
    );
    mockText("אנחנו פתוחים 09:00-18:00, ימים א-ה.");

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "עד איזו שעה אתם עונים בערך היום?", // odd, unscripted phrasing
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).toContain("09:00");
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toEqual([]);
  });

  it("7: an ACT proposal referencing a non-existent entity is rejected by deterministic validation, no DB mutation", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [realDoc] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "real.pdf", status: "approved" }).returning();

    mockObjectSequence(
      NO_REFERENCE,
      {
        outcome: "ACT",
        confidence: 0.95,
        action: {
          actionKind: "correct_resolved",
          actionTargetType: "document",
          actionTargetId: "00000000-0000-0000-0000-000000000000", // hallucinated, not a real row
          actionDesiredOutcome: "mark_withdrawn",
        },
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "בעצם תבטלו את המסמך ההוא",
    });
    expect(result.handled).toBe(true); // a reply was sent (clarification), just no mutation
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, realDoc.id));
    expect(doc.status).toBe("approved"); // completely unaffected — the real document was never touched
  });

  it("8: an LLM's grounded citation of a document never itself changes that document's status", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [doc] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "id.pdf", status: "approved" }).returning();

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ANSWER", confidence: 0.9, answerGroundedOn: [doc.id] } // cites the real document as a fact, but this is ANSWER, not ACT
    );
    mockText("כן, קיבלנו את זה, זה כבר מאושר אצלנו.");

    await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "קיבלתם את התעודת זהות שלי?",
    });
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("approved"); // reading a fact for ANSWER never writes it
  });

  it("9: an explicit user correction (via reference resolution) overrides a stale assumption, and the ACT targets the corrected entity", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [docA] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.pdf", status: "unsolicited_approved" }).returning();
    const [docB] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "b.pdf", status: "approved" }).returning();

    mockObjectSequence(
      // reference resolution: the correction explicitly names document B, overriding whatever was assumed before
      { status: "resolved", referentKind: "document", referentId: docB.id, provenance: "message_explicit", confidence: 0.93, basis: "correction to the second document" },
      {
        outcome: "ACT",
        confidence: 0.9,
        action: {
          actionKind: "correct_resolved",
          actionTargetType: "document",
          actionTargetId: docB.id, // reasoning correctly used the corrected referent, not docA
          actionDesiredOutcome: "save_as_extra",
        },
      }
    );

    await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "לא, התכוונתי למסמך השני",
    });
    const [a] = await db.select().from(schema.documents).where(eq(schema.documents.id, docA.id));
    const [b] = await db.select().from(schema.documents).where(eq(schema.documents.id, docB.id));
    expect(a.status).toBe("unsolicited_approved"); // untouched
    expect(b.status).toBe("identity_anomaly_confirmed"); // save_as_extra's real resulting status, legal only from "approved"
  });

  it("10: a valid ACT with a valid action contract passes validation and the real handler performs the mutation", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
        kind: "unsolicited_document", status: "pending",
        question: "שלחת קבלה בכוונה?",
        payload: { documentIds: [], documentType: "קבלה" },
      })
      .returning();

    mockObjectSequence(
      NO_REFERENCE,
      {
        outcome: "ACT",
        confidence: 0.9,
        action: { actionKind: "resolve_pending", actionOpenQuestionId: pending.id, actionAnswer: "confirm" },
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "כן שלחתי בכוונה",
    });
    expect(result.handled).toBe(true);
    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.id, pending.id));
    expect(row.status).toBe("confirmed"); // the real handler actually ran
  });

  it("11: the original root-cause example ('מתי הכי מאוחר אני יכול לשלוח') — no fabricated deadline, honest answer, no auto-escalation", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ANSWER", confidence: 0.75, answerGroundedOn: [] } // no deadline fact exists anywhere in the pool — nothing to cite
    );
    mockText("אין לנו מועד אחרון קבוע שנקבע מולך — אפשר לשלוח בכל שלב עד שנקבל את כל המסמכים.");

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "מתי הכי מאוחר אני יכול לשלוח?",
    });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2]).not.toMatch(/\d{1,2}[./]\d{1,2}/); // no fabricated date
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toEqual([]);
  });

  it("12: an unrelated approved policy exists but nothing grounds THIS question -> no policy is invented into the answer", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    await db.insert(schema.approvedPolicies).values({
      organizationId: orgId,
      questionSummary: "אפשר לשלוח צילום במקום סריקה?",
      decisionText: "כן, צילום ברור מספיק.",
      category: "other",
      isActive: true,
    });

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ANSWER", confidence: 0.7, answerGroundedOn: [] } // the model correctly did NOT cite the unrelated policy
    );
    mockText("אין לי כרגע מידע מאומת שעונה על השאלה הזו — אבדוק ואחזור אליך.");

    await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "יש לכם חניה בתשלום?",
    });
    // Verify composeGroundedAnswer's own generateText call never received the unrelated policy's text.
    const textCallArgs = generateText.mock.calls[0]?.[0];
    const promptContent = JSON.stringify(textCallArgs);
    expect(promptContent).not.toContain("צילום ברור מספיק");
  });
});

// Root-cause fix (production incident, 2026-08-15) — the schema
// restructure (discriminated union) touched every outcome/actionKind's own
// shape. These prove each one still reaches its real handler and produces
// the same real business effect as before the schema change — the
// "mapping compatibility" proof at the business-logic level, complementing
// conversationUnderstanding.schema.test.ts's real-provider schema-validity
// proof. Covers the outcome (UNRELATED) and the five actionKind branches
// (resolve_clarification, report_missing_document, finish_request, defer,
// resolve_review_item) the Phase 3 suite above didn't already exercise.
describe("understandConversationTurn — every outcome/actionKind branch still reaches its real handler after the schema restructure", () => {
  it("UNRELATED — no reply, no mutation, nothing escalated", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    mockObjectSequence(NO_REFERENCE, { outcome: "UNRELATED", confidence: 0.9 });

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "מה שלומך היום",
    });
    expect(result).toEqual({ handled: false, outcome: "UNRELATED" });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("ACT / resolve_clarification — the real document_clarification handler runs", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [doc] = await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, fileName: "mystery.pdf", status: "needs_review" }).returning();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
        kind: "document_clarification", status: "pending",
        question: "איזה מסמך זה?",
        payload: { documentId: doc.id },
      })
      .returning();

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ACT", confidence: 0.9, action: { actionKind: "resolve_clarification", actionOpenQuestionId: pending.id, actionReplyText: "זו תעודת זהות" } }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "זו תעודת זהות",
    });
    expect(result.handled).toBe(true);
    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.id, pending.id));
    expect(row.status).toBe("confirmed"); // the real handler actually resolved it
  });

  it("ACT / report_missing_document — the real requirement-exception handler runs", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [req] = await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "אישור ניהול חשבון בנק" }).returning();

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ACT", confidence: 0.9, action: { actionKind: "report_missing_document", actionMentionedType: "אישור ניהול חשבון" } }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "אין לי אישור ניהול חשבון, איבדתי אותו",
    });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.collectionRequestRequirements).where(eq(schema.collectionRequestRequirements.id, req.id));
    expect(after.exceptionStatus).toBe("reported_missing"); // the real handler actually ran
  });

  it("ACT / finish_request — the real completion handler runs", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    // A single, already-satisfied requirement — nothing left for the real
    // completion gate to block on.
    await db.update(schema.collectionRequests).set({ status: "active" }).where(eq(schema.collectionRequests.id, requestId));
    const [req] = await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "תעודת זהות" }).returning();
    await db.insert(schema.documents).values({ organizationId: orgId, collectionRequestId: requestId, requirementId: req.id, fileName: "id.pdf", status: "approved" });

    mockObjectSequence(NO_REFERENCE, { outcome: "ACT", confidence: 0.9, action: { actionKind: "finish_request" } });

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "סיימתי לשלוח הכל",
    });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("completed"); // the real handler actually ran
  });

  it("ACT / defer — the real deferral handler runs (and its own downstream classifyDeferralIntent call is unaffected by this schema)", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    mockObjectSequence(
      NO_REFERENCE,
      { outcome: "ACT", confidence: 0.9, action: { actionKind: "defer", actionReplyText: "אשלח בעוד שבוע" } },
      // classifyDeferralIntent (src/lib/ai/deferralIntent.ts) — a
      // completely separate, narrower schema, untouched by this fix.
      { kind: "scheduled", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: 1, namedPeriod: null }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "אשלח בעוד שבוע",
    });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(after.deferredReminderAt).not.toBeNull(); // the real handler actually ran
  });

  it("ACT / resolve_review_item — the real review-item handler runs", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
        clientQuestion: "אפשר להגיש מאוחר יותר?", category: "alternative_or_policy_question", status: "pending",
      })
      .returning();

    mockObjectSequence(
      NO_REFERENCE,
      {
        outcome: "ACT",
        confidence: 0.9,
        action: {
          actionKind: "resolve_review_item",
          actionReviewItemId: item.id,
          actionReviewAction: "close_resolved",
          actionReviewReason: "הלקוח הבהיר בעצמו",
          actionAcknowledgment: "תודה, הבנתי!",
        },
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "בעצם זה לא משנה, אשלח בזמן",
    });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved"); // the real handler actually ran
  });
});

describe("understandConversationTurn — Phase 4: REASONING_FAILED", () => {
  it("a genuine reasoning failure (provider exception) is REASONING_FAILED, never silently treated as UNRELATED or routed to legacy", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    generateObject.mockResolvedValueOnce({ object: NO_REFERENCE }); // reference resolution succeeds
    generateObject.mockRejectedValueOnce(new Error("provider timeout")); // reasonAboutMessage's own call fails

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "שאלה כלשהי",
    });

    expect(result).toEqual({ handled: false, outcome: "REASONING_FAILED" });
    expect(sendTextMessage).not.toHaveBeenCalled(); // silent, deterministic — no reply
    const reviewItems = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toEqual([]); // no mutation of any kind

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId));
    const failureEvents = audits.filter((a) => a.eventType === "message.conversation_reasoning_failed");
    const outcomeEvents = audits.filter((a) => a.eventType === "message.conversation_reasoning_outcome");
    expect(failureEvents).toHaveLength(1); // distinct, observable event type
    expect(outcomeEvents).toEqual([]); // never logged as if it were a real decision
  });
});

describe("understandConversationTurn — Phase 4: cross-organization / wrong-request entity safety", () => {
  it("a real document that exists but belongs to a DIFFERENT organization's request cannot be mutated, even if the model names its real id", async () => {
    // A second, unrelated organization with its own real document — proves
    // this isn't a hallucinated/nonexistent id (already covered by Phase 3
    // test #7), but a genuinely real row that simply doesn't belong to the
    // current turn's own organization/collectionRequest.
    const other = await seedOrgAndClient();
    const otherRequest = await seedRequest(other.orgId, other.clientId, other.serviceId, "other-org-p1");
    const [foreignDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: other.orgId, collectionRequestId: otherRequest.requestId, fileName: "foreign.pdf", status: "approved" })
      .returning();

    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    mockObjectSequence(
      NO_REFERENCE,
      {
        outcome: "ACT",
        confidence: 0.95,
        action: {
          actionKind: "correct_resolved",
          actionTargetType: "document",
          actionTargetId: foreignDoc.id, // real row, real id — just the wrong organization/request
          actionDesiredOutcome: "mark_withdrawn",
        },
      }
    );

    const result = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId,
      messageText: "תבטלו את המסמך הזה",
    });
    expect(result.handled).toBe(true); // a clarification reply was sent, not silence

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, foreignDoc.id));
    expect(after.status).toBe("approved"); // completely untouched — cross-organization mutation blocked
  });
});

describe("understandConversationTurn — Phase 4: ESCALATE dedup", () => {
  it("two independent ESCALATE turns with the exact same client question (a retry/redelivery re-running reasoning) create at most one review item and send at most one acknowledgment", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");
    const messageText = "אפשר שאבא שלי יגיש במקומי?";
    const escalateOutcome = {
      outcome: "ESCALATE",
      confidence: 0.8,
      escalateCategory: "alternative_or_policy_question",
      escalateGist: "בקשה שאדם אחר יגיש",
    };

    // Turn 1 — the "original" attempt.
    generateObject.mockResolvedValueOnce({ object: NO_REFERENCE });
    generateObject.mockResolvedValueOnce({ object: escalateOutcome });
    const first = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText,
    });
    expect(first.outcome).toBe("ESCALATE");

    // Turn 2 — simulates a retry/redelivery of the SAME inbound message:
    // handleInboundMessage re-runs from scratch (route.ts's own claim/retry
    // contract — see webhookIdempotency.ts), so reasoning runs again with
    // the exact same literal text and reaches the exact same ESCALATE
    // conclusion independently.
    generateObject.mockResolvedValueOnce({ object: NO_REFERENCE });
    generateObject.mockResolvedValueOnce({ object: escalateOutcome });
    const second = await understandConversationTurn({
      organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText,
    });
    expect(second.outcome).toBe("ESCALATE");

    const reviewItems = await db
      .select()
      .from(schema.employeeReviewItems)
      .where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toHaveLength(1); // never two, even though ESCALATE "succeeded" twice independently

    // Exactly one client-facing acknowledgment — the second (deduped) turn
    // never re-sends "העברתי את השאלה...".
    const acknowledgments = sendTextMessage.mock.calls.filter((call) => call[2] === "העברתי את השאלה לבדיקה מול המשרד ואעדכן אותך כשאקבל תשובה.");
    expect(acknowledgments).toHaveLength(1);
  });

  it("a genuinely different question on the same request is never suppressed by the dedup index", async () => {
    const { orgId, clientId, serviceId } = await seedOrgAndClient();
    const { requestId, conversationId } = await seedRequest(orgId, clientId, serviceId, "p1");

    const escalateFor = (gist: string) => ({
      outcome: "ESCALATE",
      confidence: 0.8,
      escalateCategory: "other" as const,
      escalateGist: gist,
    });

    generateObject.mockResolvedValueOnce({ object: NO_REFERENCE });
    generateObject.mockResolvedValueOnce({ object: escalateFor("first question") });
    await understandConversationTurn({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "שאלה ראשונה" });

    generateObject.mockResolvedValueOnce({ object: NO_REFERENCE });
    generateObject.mockResolvedValueOnce({ object: escalateFor("second question") });
    await understandConversationTurn({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "שאלה שנייה לגמרי" });

    const reviewItems = await db
      .select()
      .from(schema.employeeReviewItems)
      .where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItems).toHaveLength(2); // two real, distinct questions — dedup never over-suppresses
  });
});
