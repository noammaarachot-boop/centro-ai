import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Real production incident this suite exists to cover (scenario 4 in the
// owner's own test list): client answers "לא" to an identity-mismatch
// question (document kept as an unattached extra, requirement stays open),
// then immediately types "שלחתי בטעות" — nothing in the pipeline recognized
// this as a correction to the just-resolved decision. runCorrectionLayer is
// the fix; these tests exercise it directly (bypassing the webhook route's
// thin HTTP plumbing), against a real PGlite-backed DB.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const getValidAccessToken = vi.fn();
vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return { ...actual, getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args) };
});

const renameDriveFile = vi.fn();
vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return { ...actual, renameDriveFile: (...args: unknown[]) => renameDriveFile(...args) };
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

const classifyCorrectionIntent = vi.fn();
vi.mock("@/lib/correction/correctionClassifier", async () => {
  const actual = await vi.importActual<typeof import("./correctionClassifier")>("./correctionClassifier");
  return { ...actual, classifyCorrectionIntent: (...args: unknown[]) => classifyCorrectionIntent(...args) };
});

const { runCorrectionLayer } = await import("./correctionDispatch");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  getValidAccessToken.mockReset();
  getValidAccessToken.mockResolvedValue("fake-token");
  renameDriveFile.mockReset();
  renameDriveFile.mockResolvedValue(undefined);
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  classifyCorrectionIntent.mockReset();
});

async function seedRequest() {
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

async function insertDocument(orgId: string, requestId: string, overrides: Partial<typeof schema.documents.$inferInsert>) {
  const [doc] = await db
    .insert(schema.documents)
    .values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "doc.pdf",
      status: "unsolicited_approved",
      ...overrides,
    })
    .returning();
  return doc;
}

describe("runCorrectionLayer — not_applicable", () => {
  it("returns handled:false and sends nothing, for a message the classifier doesn't recognize", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await insertDocument(orgId, requestId, {});
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "not_applicable",
      confidence: 0,
      answer: null,
      targetType: null,
      targetId: null,
      desiredOutcome: null,
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "מה קורה" });
    expect(result.handled).toBe(false);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

describe("runCorrectionLayer — corrects_resolved (scenario 4: the exact לא -> extra -> שלחתי בטעות sequence)", () => {
  it("clear correction (high confidence, legal outcome) -> immediate action + immediate reply", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, {
      status: "identity_anomaly_confirmed",
      fileName: "תעודת זהות.pdf",
      googleDriveFileId: "drive-file-1",
    });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "mark_withdrawn",
    });

    const result = await runCorrectionLayer({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      messageText: "שלחתי בטעות",
    });

    expect(result.handled).toBe(true);
    // Immediate reply, sent synchronously within this same call (scenario 8:
    // the 2-minute timer must never delay a reply).
    expect(sendTextMessage).toHaveBeenCalledTimes(1);

    const [updated] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(updated.status).toBe("withdrawn_by_correction");
    // Never physically deleted — row stays, per the "mark, never delete"
    // product decision.
    expect(updated.id).toBe(doc.id);
    // Drive file renamed, not deleted (scenario 9: DB/Drive consistency).
    expect(renameDriveFile).toHaveBeenCalledWith("fake-token", "drive-file-1", expect.stringContaining("[בוטל]"));

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    // The 2-minute case-review timer was armed (for the eventual summary),
    // never used to delay the reply itself.
    expect(conversation.pendingCaseReviewAt).not.toBeNull();
  });

  it("ambiguous correction (low confidence) -> immediate clarification, zero state change", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed", googleDriveFileId: "drive-file-1" });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.4, // below CORRECTION_ACT_CONFIDENCE
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "mark_withdrawn",
    });

    const before = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "אולי זה לא נכון" });
    const after = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));

    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(after).toEqual(before); // byte-for-byte unchanged
    expect(renameDriveFile).not.toHaveBeenCalled();
  });

  it("an invalid/hallucinated targetId (not in the candidate list) is treated as unclear, never trusted", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed" });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: "00000000-0000-0000-0000-000000000000", // not a real candidate
      desiredOutcome: "mark_withdrawn",
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "בטל את זה" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(renameDriveFile).not.toHaveBeenCalled();
  });

  it("an outcome outside the legal set for the document's live status -> clarification, no mutation", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    // unsolicited_approved only legally supports mark_withdrawn, not attach_to_requirement.
    const doc = await insertDocument(orgId, requestId, { status: "unsolicited_approved" });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "attach_to_requirement",
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "צרף את זה לדרישה" });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("unsolicited_approved");
  });

  it("a document whose bytes were already cleared (never uploaded) gets the honest 'can't recover' reply, not a silent no-op", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, { status: "unsolicited_rejected", pendingFileContent: null });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "mark_withdrawn",
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "טעיתי, זה כן שלי" });
    expect(result.handled).toBe(true);
    expect(sendTextMessage.mock.calls[0][2] ?? sendTextMessage.mock.calls[0][1]).toBeDefined();
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("unsolicited_rejected"); // unchanged — never resurrected
  });

  it("refers to an earlier document, not the most recent one (scenario 3)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const base = Date.now();
    const older = await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed", fileName: "רישיון.pdf", receivedAt: new Date(base) });
    const newer = await insertDocument(orgId, requestId, { status: "unsolicited_approved", fileName: "קבלה.pdf", receivedAt: new Date(base + 5000) });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: older.id, // explicitly the earlier one, not `newer`
      desiredOutcome: "mark_withdrawn",
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "התכוונתי למסמך הקודם, תבטל אותו" });
    expect(result.handled).toBe(true);
    const [olderAfter] = await db.select().from(schema.documents).where(eq(schema.documents.id, older.id));
    const [newerAfter] = await db.select().from(schema.documents).where(eq(schema.documents.id, newer.id));
    expect(olderAfter.status).toBe("withdrawn_by_correction");
    expect(newerAfter.status).toBe("unsolicited_approved"); // untouched
  });
});

describe("runCorrectionLayer — reversing a decline into an attach (the live incident's exact reverse)", () => {
  it("attach_to_requirement re-validates the requirement is still open before attaching, using the originating confirmation's matchedRequirementId", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed", fileName: "תעודת זהות.pdf" });
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "identity_anomaly",
      status: "declined",
      question: "האם הוא נשלח במקום תעודת הזהות של רז שלום?",
      payload: { documents: [{ id: doc.id, matchedRequirementId: requirementId }] },
      respondedAt: new Date(),
    });
    const [confirmationRow] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "confirmation",
      targetId: confirmationRow.id,
      desiredOutcome: "attach_to_requirement",
    });

    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "טעיתי, דווקא כן זה מחליף" });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("approved");
    expect(after.requirementId).toBe(requirementId);
  });

  it("falls back to save_as_extra if the requirement was already satisfied by something else in the meantime", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    // Another document already satisfies the requirement.
    await insertDocument(orgId, requestId, { status: "approved", requirementId, fileName: "id-real.pdf" });
    const doc = await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed", fileName: "תעודת זהות.pdf" });
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "identity_anomaly",
      status: "declined",
      question: "...",
      payload: { documents: [{ id: doc.id, matchedRequirementId: requirementId }] },
      respondedAt: new Date(),
    });
    const [confirmationRow] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "confirmation",
      targetId: confirmationRow.id,
      desiredOutcome: "attach_to_requirement",
    });

    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "טעיתי, דווקא כן" });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    // Not force-attached (the requirement is already satisfied) — kept as extra instead.
    expect(after.status).toBe("identity_anomaly_confirmed");
    expect(after.requirementId).toBeNull();
  });
});

describe("runCorrectionLayer — answers_open_question", () => {
  it("a non-keyword reply that confidently answers the currently-open question resolves it via the normal dispatch", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, {
      status: "unsolicited_pending_confirmation",
      pendingFileContent: Buffer.from("bytes"),
      pendingFileMimeType: "application/pdf",
    });
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: { documentIds: [doc.id], documentType: "מסמך נוסף" },
    });

    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "answers_open_question",
      confidence: 0.9,
      answer: "decline",
      targetType: null,
      targetId: null,
      desiredOutcome: null,
    });

    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "לא, זו טעות" });
    expect(result.handled).toBe(true);
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("unsolicited_rejected");
  });

  it("low-confidence answer -> clarification, leaves the question open", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      kind: "unsolicited_document",
      status: "pending",
      question: "האם שלחת בכוונה?",
      payload: { documentIds: ["nonexistent"], documentType: "מסמך נוסף" },
    });
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "answers_open_question",
      confidence: 0.3,
      answer: "confirm",
      targetType: null,
      targetId: null,
      desiredOutcome: null,
    });
    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "אולי" });
    expect(result.handled).toBe(true);
    const [pc] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(pc.status).toBe("pending"); // untouched
  });
});

describe("runCorrectionLayer — within the 48h post-completion window: un-completing a finished request (scenario 5)", () => {
  it("auto-reopens the request via the existing completed->active pathway when a correction undoes the document that satisfied the last requirement", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, { status: "approved", requirementId, fileName: "id.pdf" });
    await db
      .update(schema.collectionRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.collectionRequests.id, requestId));
    await db.update(schema.conversations).set({ status: "closed" }).where(eq(schema.conversations.id, conversationId));

    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "mark_withdrawn",
    });

    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "שלחתי בטעות, זה לא באמת שלי" });
    expect(result.handled).toBe(true);

    const [docAfter] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(docAfter.status).toBe("withdrawn_by_correction");

    const [requestAfter] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(requestAfter.status).toBe("active"); // auto-reopened, not left silently "completed" with a missing requirement
    expect(requestAfter.extensionActive).toBe(true); // never auto-closes again the instant this same document would satisfy it

    const [conversationAfter] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversationAfter.status).toBe("open");
  });

  it("does NOT reopen when the correction doesn't affect a satisfied requirement (e.g. detaching an already-extra document)", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequest();
    await insertDocument(orgId, requestId, { status: "approved", requirementId, fileName: "id.pdf" }); // still satisfies the requirement
    const extraDoc = await insertDocument(orgId, requestId, { status: "unsolicited_approved", fileName: "extra.pdf" });
    await db
      .update(schema.collectionRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.collectionRequests.id, requestId));
    await db.update(schema.conversations).set({ status: "closed" }).where(eq(schema.conversations.id, conversationId));

    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: extraDoc.id,
      desiredOutcome: "mark_withdrawn",
    });

    await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "בטל את המסמך הנוסף" });

    const [requestAfter] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(requestAfter.status).toBe("completed"); // still genuinely complete — nothing to reopen
  });
});

describe("runCorrectionLayer — DB/Drive consistency, including a Drive rename failure (scenario 9)", () => {
  it("a non-fatal Drive rename failure still leaves the DB status correctly updated (never an inconsistent half-applied state)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const doc = await insertDocument(orgId, requestId, { status: "identity_anomaly_confirmed", googleDriveFileId: "drive-file-x" });
    renameDriveFile.mockRejectedValueOnce(new Error("Drive API transient failure"));
    classifyCorrectionIntent.mockResolvedValueOnce({
      kind: "corrects_resolved",
      confidence: 0.95,
      answer: null,
      targetType: "document",
      targetId: doc.id,
      desiredOutcome: "mark_withdrawn",
    });

    const result = await runCorrectionLayer({ organizationId: orgId, clientId, collectionRequestId: requestId, conversationId, messageText: "שלחתי בטעות" });
    expect(result.handled).toBe(true);
    // Non-fatal — same resilience philosophy as markDocumentSupersededInDrive:
    // the DB write is the source of truth and always lands even if the
    // best-effort Drive rename fails.
    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("withdrawn_by_correction");
    expect(sendTextMessage).toHaveBeenCalledTimes(1); // still acked, never crashed
  });
});
