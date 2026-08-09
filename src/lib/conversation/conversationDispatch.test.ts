import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * The unified conversation-understanding layer — the real production
 * incident this whole architecture change exists to fix: a client's new
 * message that is clearly a DIFFERENT question, not an answer to whatever
 * happens to be open, must never be silently swallowed as if it answered
 * the open question. These tests exercise runConversationUnderstanding
 * directly against a real PGlite-backed DB, with the AI classifier itself
 * mocked (its own correctness is covered by conversationIntent.test.ts) —
 * this file proves the DISPATCH logic given a classification, for every
 * intent kind.
 */

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const getValidAccessToken = vi.fn();
vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return { ...actual, getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args) };
});

interface FakeFolder {
  id: string;
  name: string;
  parentId: string;
  properties?: Record<string, string>;
  trashed?: boolean;
}
interface FakeFile {
  id: string;
  name: string;
  parentId: string;
}
let fakeFolders: FakeFolder[] = [];
let fakeFiles: FakeFile[] = [];
let nextId = 1;

vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return {
    ...actual,
    renameDriveFile: vi.fn(),
    createDriveFolder: vi.fn(async (_token: string, name: string, parentId?: string, properties?: Record<string, string>) => {
      const id = `folder-${nextId++}`;
      fakeFolders.push({ id, name, parentId: parentId ?? "", properties });
      return { id, name };
    }),
    findFoldersByName: vi.fn(async (_token: string, parentId: string, name: string) =>
      fakeFolders.filter((f) => f.parentId === parentId && f.name === name && !f.trashed).map((f) => ({ id: f.id, name: f.name }))
    ),
    findFolderByClientProperty: vi.fn(async (_token: string, parentId: string, clientId: string) => {
      const found = fakeFolders.find((f) => f.parentId === parentId && !f.trashed && f.properties?.centroClientId === clientId);
      return found ? { id: found.id, name: found.name } : null;
    }),
    setFolderClientProperty: vi.fn(async (_token: string, folderId: string, clientId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.properties = { ...folder.properties, centroClientId: clientId };
    }),
    listFolderFiles: vi.fn(async (_token: string, folderId: string) =>
      fakeFiles.filter((f) => f.parentId === folderId).map((f) => ({ id: f.id, name: f.name, webViewLink: null }))
    ),
    uploadDriveFile: vi.fn(async (_token: string, options: { name: string; parentId: string }) => {
      const id = `file-${nextId++}`;
      fakeFiles.push({ id, name: options.name, parentId: options.parentId });
      return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
    }),
  };
});

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: vi.fn(),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});

const classifyConversationIntent = vi.fn();
vi.mock("@/lib/conversation/conversationIntent", async () => {
  const actual = await vi.importActual<typeof import("./conversationIntent")>("./conversationIntent");
  return { ...actual, classifyConversationIntent: (...args: unknown[]) => classifyConversationIntent(...args) };
});

// applyDeferralIfAny/classifyDeferralIntent/classifyFollowUpIntent all go
// through the same "ai" module — mocked at the lowest level so the
// deferral_promise dispatch test can control it precisely without needing
// a real model.
const generateObject = vi.fn();
vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateObject: (...args: unknown[]) => generateObject(...args) };
});
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: async () => ({ modelId: "fake" }),
}));

const { runConversationUnderstanding } = await import("./conversationDispatch");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  fakeFolders = [];
  fakeFiles = [];
  nextId = 1;
  getValidAccessToken.mockReset();
  getValidAccessToken.mockResolvedValue("fake-token");
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  classifyConversationIntent.mockReset();
  generateObject.mockReset();
});

function baseClassification(overrides: Partial<Awaited<ReturnType<typeof classifyConversationIntent>>>) {
  return {
    kind: "unrelated" as const,
    confidence: 0.9,
    pendingAnswer: null,
    correctionTargetType: null,
    correctionTargetId: null,
    correctionDesiredOutcome: null,
    missingDocumentMentionedType: null,
    reviewCategory: null,
    reviewGist: null,
    reviewItemTargetId: null,
    reviewItemAction: null,
    reviewItemReason: null,
    naturalAcknowledgment: null,
    documentQuestionCategory: null,
    ...overrides,
  };
}

async function seedRequest() {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      whatsappPhoneNumberId: "phone-1",
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "waiting_for_client" })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id, requirementId: requirement.id, conversationId: conversation.id };
}

describe("runConversationUnderstanding — the production incident: a new question must never be swallowed by an open pending question", () => {
  it("a document_clarification is open, client sends a genuinely NEW question — the open clarification is left untouched, not force-answered", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    const [doc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, requirementId: null, fileName: "mystery.pdf", status: "clarification_requested" })
      .returning();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "document_clarification",
      status: "pending",
      question: "מה זה המסמך הזה?",
      payload: { documentId: doc.id },
    });

    // The classifier itself correctly recognizes this is NOT an answer to
    // the clarification question — it's a brand new, unrelated-to-the-open-item
    // question about a substitute document.
    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({ kind: "needs_employee_review", reviewCategory: "alternative_or_policy_question", reviewGist: "אפשר לשלוח דרכון במקום?" })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "אפשר לשלוח דרכון במקום תעודת זהות?",
    });

    expect(result.handled).toBe(true);
    // The clarification question is untouched — still open, never
    // force-resolved with the new message's text.
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("pending");
    // A review item was opened instead, with the client's real words.
    const [reviewItem] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItem.clientQuestion).toContain("דרכון");
    expect(reviewItem.category).toBe("alternative_or_policy_question");
    void requirementId;
  });

  it("a yes/no confirmation is open, client sends a genuinely new question (not כן/לא) — left open, routed to review instead", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: { documentIds: [] },
    });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({ kind: "needs_employee_review", reviewCategory: "human_request", reviewGist: "רוצה לדבר עם נציג" })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "אני רוצה לדבר עם מישהו מהמשרד",
    });

    expect(result.handled).toBe(true);
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("pending"); // never guessed-resolved
  });
});

describe("runConversationUnderstanding — resolves_pending", () => {
  it("document_clarification kind: the message's own raw text becomes the clarification answer", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    const [doc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "mystery.pdf", status: "clarification_requested" })
      .returning();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "document_clarification",
      status: "pending",
      question: "מה זה המסמך הזה?",
      payload: { documentId: doc.id },
    });

    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "resolves_pending", confidence: 0.9 }));

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "זה תלוש המשכורת שלי מיולי",
    });

    expect(result.handled).toBe(true);
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("confirmed");
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // an ack was sent, never silent
    void requirementId;
  });

  it("yes/no kind: dispatches through the existing confirm/decline machinery", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: { documentIds: [] },
    });

    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "resolves_pending", pendingAnswer: "decline", confidence: 0.95 }));

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "לא, זו טעות",
    });

    expect(result.handled).toBe(true);
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("declined");
  });

  it("low confidence -> immediate clarification, question stays open", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: { documentIds: [] },
    });
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "resolves_pending", pendingAnswer: "confirm", confidence: 0.3 }));

    const result = await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "אולי" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("pending");
  });
});

describe("runConversationUnderstanding — reports_missing_document", () => {
  it("opens a real employee exception on the single outstanding requirement", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "reports_missing_document", missingDocumentMentionedType: null, confidence: 0.9 }));

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "אין לי גישה לתעודת הזהות שלי כרגע, איבדתי אותה",
    });

    expect(result.handled).toBe(true);
    const [requirement] = await db.select().from(schema.collectionRequestRequirements).where(eq(schema.collectionRequestRequirements.id, requirementId));
    expect(requirement.exceptionStatus).toBe("reported_missing");
    expect(requirement.exceptionNote).toContain("איבדתי");
    // Also mirrored into the central review queue.
    const [reviewItem] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.collectionRequestId, requestId));
    expect(reviewItem.category).toBe("missing_document");
  });
});

describe("runConversationUnderstanding — asks_document_question", () => {
  it("answers deterministically from real requirement facts, never invents", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "asks_document_question", documentQuestionCategory: "request_overview", confidence: 0.9 }));

    const result = await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "מה עדיין חסר לי?" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("תעודת זהות");
  });
});

describe("runConversationUnderstanding — finished_signal", () => {
  it("low confidence never completes the request", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "finished_signal", confidence: 0.2 }));

    await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "אולי סיימתי?" });
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
  });
});

describe("runConversationUnderstanding — deferral_promise", () => {
  it("when the internal re-check disagrees (returns false), the client still gets a reply, never silence", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "deferral_promise", confidence: 0.9 }));
    // classifyDeferralIntent -> not_dated, classifyFollowUpIntent -> false
    generateObject.mockResolvedValueOnce({
      object: { kind: "not_dated", weekday: null, explicitDay: null, explicitMonth: null, explicitYear: null, relativeDays: null, relativeWeeks: null, namedPeriod: null },
    });
    generateObject.mockResolvedValueOnce({ object: { isFollowUpPromise: false } });

    const result = await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "אולי בקרוב" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // never silent
  });
});

describe("runConversationUnderstanding — resolves_review_item", () => {
  async function seedReviewItem(params: { orgId: string; clientId: string; requestId: string; conversationId: string; status: "pending" | "resolved" }) {
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: params.orgId,
        clientId: params.clientId,
        collectionRequestId: params.requestId,
        conversationId: params.conversationId,
        clientQuestion: "יש לי רק ספח, זה מספיק?",
        category: "alternative_or_policy_question",
        understoodContext: { relatedRequirementName: "תעודת זהות", gist: "האם ספח מספיק במקום תעודת הזהות" },
        status: params.status,
        ...(params.status === "resolved" ? { resolutionText: "כן, זה בסדר", resolvedBy: "employee" as const, resolvedAt: new Date() } : {}),
      })
      .returning();
    return item;
  }

  it("close_resolved at high confidence: closes the item with an ai_context audit trail and sends the natural acknowledgment — the real reported scenario (client finds the ID after a ספח question was open)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const item = await seedReviewItem({ orgId, clientId, requestId, conversationId, status: "pending" });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.92,
        reviewItemTargetId: item.id,
        reviewItemAction: "close_resolved",
        reviewItemReason: "הלקוח מצא את תעודת הזהות המקורית.",
        naturalAcknowledgment: "מעולה, אפשר לשלוח אותה כאן.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "לא משנה, מצאתי את תעודת הזהות ואני שולח אותה",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved");
    expect(after.resolvedBy).toBe("ai_context");
    expect(sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "מעולה, אפשר לשלוח אותה כאן.");
  });

  it("close_resolved below the (deliberately high) confidence bar: item stays open, client gets a clarification instead — never a guessed closure", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const item = await seedReviewItem({ orgId, clientId, requestId, conversationId, status: "pending" });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.7, // above MIN_ACT_CONFIDENCE but below REVIEW_ITEM_CLOSE_CONFIDENCE (0.85)
        reviewItemTargetId: item.id,
        reviewItemAction: "close_resolved",
        reviewItemReason: "נראה שהסתדר, אבל לא ודאי",
        naturalAcknowledgment: "טוב לשמוע.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "נראה לי שהסתדרתי עם זה",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("pending"); // never guessed-closed
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // still gets a reply, just a clarification
  });

  it("add_context_note: item stays open, a note is appended, client still gets a warm reply", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const item = await seedReviewItem({ orgId, clientId, requestId, conversationId, status: "pending" });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.75,
        reviewItemTargetId: item.id,
        reviewItemAction: "add_context_note",
        reviewItemReason: "הלקוח ציין שהספח גם הוא ישן.",
        naturalAcknowledgment: "תודה, רשמתי את זה.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "דרך אגב הספח שיש לי גם הוא כבר ישן",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("pending");
    const updates = after.contextUpdates as Array<{ note: string }> | null;
    expect(updates).toHaveLength(1);
    expect(sendTextMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), "תודה, רשמתי את זה.");
  });

  it("close_resolved on an item already resolved by an employee in the meantime is not a legal action — stays as the employee left it", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const item = await seedReviewItem({ orgId, clientId, requestId, conversationId, status: "resolved" });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.95,
        reviewItemTargetId: item.id,
        reviewItemAction: "close_resolved", // illegal — already resolved, only add_context_note is legal now
        naturalAcknowledgment: "מעולה.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "מצאתי, תודה",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.resolvedBy).toBe("employee"); // untouched — the AI never overrides an employee's own resolution
  });

  it("generalizes to a wholly different review-item scenario/phrasing never seen in the ID-card example — retracting a request for an alternative document", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [item] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        clientQuestion: "אפשר לצרף חוזה שכירות ישן במקום העדכני?",
        category: "alternative_or_policy_question",
        status: "pending",
      })
      .returning();

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.9,
        reviewItemTargetId: item.id,
        reviewItemAction: "close_resolved",
        reviewItemReason: "הלקוח מצא את החוזה העדכני וחוזר בו מהבקשה לחלופה.",
        naturalAcknowledgment: "מצוין, אפשר לשלוח את החוזה העדכני כאן.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "טוב סוף סוף מצאתי גם את החוזה החדש, זה כבר לא רלוונטי מה ששאלתי קודם",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("resolved");
    expect(after.resolvedBy).toBe("ai_context");
  });

  it("an unrecognized/stale reviewItemTargetId is never trusted — treated as unclear, item untouched", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const item = await seedReviewItem({ orgId, clientId, requestId, conversationId, status: "pending" });

    classifyConversationIntent.mockResolvedValueOnce(
      baseClassification({
        kind: "resolves_review_item",
        confidence: 0.95,
        reviewItemTargetId: "00000000-0000-0000-0000-000000000000",
        reviewItemAction: "close_resolved",
        naturalAcknowledgment: "מעולה.",
      })
    );

    const result = await runConversationUnderstanding({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "מצאתי, תודה",
    });

    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, item.id));
    expect(after.status).toBe("pending");
  });
});

describe("runConversationUnderstanding — unclear and unrelated", () => {
  it("unclear -> immediate clarification, zero state change", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "unclear", confidence: 0.3 }));
    const result = await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "היי" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("unrelated -> handled:false, fully silent, no reply", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    classifyConversationIntent.mockResolvedValueOnce(baseClassification({ kind: "unrelated", confidence: 0 }));
    const result = await runConversationUnderstanding({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "מה שעות הפעילות?" });
    expect(result.handled).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});
