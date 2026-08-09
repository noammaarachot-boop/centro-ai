import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Reproduces the exact production report: a request for רז שלום's תעודת
// זהות + דרכון instead received both documents under ישראל ישראלי's name, plus
// two unrelated invoices — and the client was flooded with 4 separate
// WhatsApp messages (one identity question per document, one unsolicited
// question per invoice). This file proves the fix: everything detected in
// one burst reaches the client as ONE combined message with clearly
// separated, independently-answerable sections — never one message per
// file, and never one message per anomaly *kind*.

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
    createDriveFolder: vi.fn(
      async (_token: string, name: string, parentId?: string, properties?: Record<string, string>) => {
        const id = `folder-${nextId++}`;
        fakeFolders.push({ id, name, parentId: parentId ?? "", properties });
        return { id, name };
      }
    ),
    findFoldersByName: vi.fn(async (_token: string, parentId: string, name: string) =>
      fakeFolders
        .filter((f) => f.parentId === parentId && f.name === name && !f.trashed)
        .map((f) => ({ id: f.id, name: f.name }))
    ),
    findFolderByClientProperty: vi.fn(async (_token: string, parentId: string, clientId: string) => {
      const found = fakeFolders.find(
        (f) => f.parentId === parentId && !f.trashed && f.properties?.centroClientId === clientId
      );
      return found ? { id: found.id, name: found.name } : null;
    }),
    setFolderClientProperty: vi.fn(async (_token: string, folderId: string, clientId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.properties = { ...folder.properties, centroClientId: clientId };
    }),
    listFolderFiles: vi.fn(async (_token: string, folderId: string) =>
      fakeFiles.filter((f) => f.parentId === folderId).map((f) => ({ id: f.id, name: f.name, webViewLink: null }))
    ),
    moveDriveFile: vi.fn(async (_token: string, fileId: string, _from: string, toParentId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.parentId = toParentId;
    }),
    trashDriveFolder: vi.fn(async (_token: string, folderId: string) => {
      const folder = fakeFolders.find((f) => f.id === folderId);
      if (folder) folder.trashed = true;
    }),
    uploadDriveFile: vi.fn(async (_token: string, options: { name: string; parentId: string }) => {
      const id = `file-${nextId++}`;
      fakeFiles.push({ id, name: options.name, parentId: options.parentId });
      return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
    }),
  };
});

const sendTextMessage = vi.fn();
const sendInteractiveButtonsMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendInteractiveButtonsMessage: (...args: unknown[]) => sendInteractiveButtonsMessage(...args),
    sendTemplateMessage: vi.fn(),
  };
});

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

const { processInboundAttachment } = await import("@/app/(app)/collections/conversationActions");
const { flushDueIntakeNotifications, resolveBatchedIntakeReply } = await import("./pendingConfirmations");
const { applyUnsolicitedConfirmationDecision } = await import("./documentIntakeReview");
const { applyIdentityAnomalyDecision } = await import("./documentIdentityVerification");

// identity_anomaly/unsolicited_document confirmations are created
// immediately at intake time (not deferred to whole-case-review time) but
// still held for the short notification-grouping window — forces that
// flush immediately for tests that need to observe the combined send.
async function forceFlush(orgId: string, requestId: string) {
  await db
    .update(schema.pendingConfirmations)
    .set({ notifyAfter: new Date(Date.now() - 1000) })
    .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
  return flushDueIntakeNotifications(orgId, requestId);
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  fakeFolders = [];
  fakeFiles = [];
  nextId = 1;
  getValidAccessToken.mockResolvedValue("fake-token");
  classifyDocumentViaVisionAI.mockReset();
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  sendInteractiveButtonsMessage.mockReset();
  sendInteractiveButtonsMessage.mockResolvedValue({ messageId: "wamid.out" });
});

async function seedRequest() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: "phone-1" })
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
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id })
    .returning();
  const [idReq] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [passportReq] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "דרכון" })
    .returning();
  return {
    orgId: org.id,
    clientId: client.id,
    requestId: request.id,
    conversationId: conversation.id,
    idReqId: idReq.id,
    passportReqId: passportReq.id,
  };
}

describe("the reported bug: ID+passport for the wrong person, plus two unrelated invoices, in one burst", () => {
  it("reaches the client as exactly one combined WhatsApp message with two clearly separated sections — not four separate messages", async () => {
    const { orgId, clientId, requestId, conversationId, idReqId, passportReqId } = await seedRequest();

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReqId,
      matchConfidence: 0.98,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("id-bytes"), "image/jpeg", "wamid.t1.1");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "דרכון",
      identificationConfidence: 0.97,
      matchedRequirementId: passportReqId,
      matchConfidence: 0.97,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "passport.jpg", null, Buffer.from("passport-bytes"), "image/jpeg", "wamid.t1.2");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
      extractedPersonName: null,
      extractedIdNumber: null,
      extractedCompanyName: null,
      identityExtractionConfidence: 0,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "invoice1.pdf", null, Buffer.from("invoice1-bytes"), "application/pdf", "wamid.t1.3");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
      extractedPersonName: null,
      extractedIdNumber: null,
      extractedCompanyName: null,
      identityExtractionConfidence: 0,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "invoice2.pdf", null, Buffer.from("invoice2-bytes"), "application/pdf", "wamid.t1.4");

    // Four documents received, none uploaded yet — every one of them is
    // held pending the client's answer.
    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(4);
    expect(allDocs.every((d) => d.googleDriveFileId === null)).toBe(true);

    // Asked about immediately, not deferred to whole-case-review time —
    // every exception already has a pendingConfirmation right after
    // intake, just not yet flushed/sent (still inside the short
    // notification-grouping window) — so no WhatsApp message yet either.
    expect(allDocs.every((d) => d.deferredReviewKind === null)).toBe(true);
    const beforeFlush = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    // Three distinct groups, not two: the ID card and the passport share
    // the same underlying identity mismatch (same wrong person) but target
    // DIFFERENT requirements — "does this replace X?" is a genuinely
    // different question for each, so they must never merge into one
    // (see anomalySignature's own doc comment) — plus the one unsolicited
    // group (the two invoices, unaffected by this).
    expect(beforeFlush).toHaveLength(3);
    expect(beforeFlush.every((r) => r.notifiedAt === null)).toBe(true);
    expect(sendTextMessage).not.toHaveBeenCalled();

    const pendingRows = beforeFlush;
    const identityRows = pendingRows.filter((r) => r.kind === "identity_anomaly");
    const unsolicitedRow = pendingRows.find((r) => r.kind === "unsolicited_document")!;
    expect(identityRows).toHaveLength(2);
    expect(identityRows.every((r) => (r.payload as { documents: unknown[] }).documents.length === 1)).toBe(true);
    expect((unsolicitedRow.payload as { documentIds: string[] }).documentIds).toHaveLength(2);

    // ...but once the short grouping window elapses, the client sees
    // exactly ONE WhatsApp message, not four.
    await forceFlush(orgId, requestId);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);

    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    // 1 message for this combined question (no earlier outbound messages
    // were sent in this flow).
    expect(messages).toHaveLength(1);

    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("תעודת זהות");
    expect(body).toContain("דרכון");
    expect(body).toContain("ישראל ישראלי");
    expect(body).toContain("חשבונית");
    // Numbered sections with independent yes/no options (keycap emoji) —
    // 3 groups × 2 options each (see above for why the ID card and
    // passport are now two separate groups, not one).
    expect(body).toContain("1️⃣");
    expect(body).toContain("2️⃣");
    expect(body).toContain("3️⃣");
    expect(body).toContain("4️⃣");
    expect(body).toContain("5️⃣");
    expect(body).toContain("6️⃣");
  });

  it("confirming one group and declining the other applies independently, each with its own audit trail, and only the confirmed group is uploaded", async () => {
    const { orgId, clientId, requestId, conversationId, idReqId } = await seedRequest();

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReqId,
      matchConfidence: 0.98,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("id-bytes"), "image/jpeg", "wamid.t2.1");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
      extractedPersonName: null,
      extractedIdNumber: null,
      extractedCompanyName: null,
      identityExtractionConfidence: 0,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "invoice1.pdf", null, Buffer.from("invoice1-bytes"), "application/pdf", "wamid.t2.3");

    await forceFlush(orgId, requestId);
    const rowsBefore = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const identityRow = rowsBefore.find((r) => r.kind === "identity_anomaly")!;
    const unsolicitedRow = rowsBefore.find((r) => r.kind === "unsolicited_document")!;
    const identityGroupIndex = identityRow.groupIndex!;
    const unsolicitedGroupIndex = unsolicitedRow.groupIndex!;

    // Confirm the identity group ("yes, sent on purpose"), decline the
    // unsolicited group ("no, sent by mistake") — both in one reply.
    const confirmOption = identityGroupIndex * 2 + 1;
    const declineOption = unsolicitedGroupIndex * 2 + 2;
    const resolved = await resolveBatchedIntakeReply(conversationId, `${confirmOption}, ${declineOption}`);
    expect(resolved).toHaveLength(2);
    for (const row of resolved) {
      await applyUnsolicitedConfirmationDecision(row);
      await applyIdentityAnomalyDecision(row);
    }

    const idDoc = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    // The identity-anomaly document here has a matchedRequirementId
    // (idReqId) — the question asked was "does this replace תעודת זהות?",
    // and confirming "yes" now genuinely attaches it to that requirement
    // (the client's own explicit answer, not a confidence-based guess).
    const identityDoc = idDoc.find((d) => d.status === "approved")!;
    const invoiceDoc = idDoc.find((d) => d.status === "unsolicited_rejected")!;
    expect(identityDoc).toBeDefined();
    expect(invoiceDoc).toBeDefined();
    expect(identityDoc.requirementId).toBe(idReqId);
    expect(identityDoc.googleDriveFileId).not.toBeNull();
    expect(invoiceDoc.status).toBe("unsolicited_rejected");
    expect(invoiceDoc.googleDriveFileId).toBeNull();

    // Only the confirmed document was actually uploaded to Drive.
    expect(fakeFiles).toHaveLength(1);

    // "כן, שלחתי בכוונה" (identity mismatch confirmed intentional) never
    // escalates to an employee — no needs_review document, no employee-
    // facing audit event, collection just continues.
    expect(idDoc.some((d) => d.status === "needs_review")).toBe(false);
    const auditEventTypesSoFar = (
      await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.collectionRequestId, requestId))
    ).map((e) => e.eventType);
    expect(auditEventTypesSoFar.some((t) => t.includes("needs_review") || t.includes("employee"))).toBe(false);

    // Independent audit trail entries exist for each document.
    const auditEvents = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditEvents.some((e) => e.eventType === "document.identity_anomaly_confirmed")).toBe(true);
    expect(auditEvents.some((e) => e.eventType === "document.unsolicited_rejected")).toBe(true);
  });

  it("a partial/unclear reply resolves only the group it addresses, leaving the other open until answered on its own", async () => {
    const { orgId, clientId, requestId, conversationId, idReqId } = await seedRequest();

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReqId,
      matchConfidence: 0.98,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("id-bytes"), "image/jpeg", "wamid.t3.1");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס",
      identificationConfidence: 0.9,
      matchedRequirementId: null,
      matchConfidence: 0,
      extractedPersonName: null,
      extractedIdNumber: null,
      extractedCompanyName: null,
      identityExtractionConfidence: 0,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "invoice1.pdf", null, Buffer.from("invoice1-bytes"), "application/pdf", "wamid.t3.3");

    await forceFlush(orgId, requestId);
    const rowsBefore = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const identityRow = rowsBefore.find((r) => r.kind === "identity_anomaly")!;
    const confirmOption = identityRow.groupIndex! * 2 + 1;

    // Answers only the identity group by number — the unsolicited group is
    // untouched, still pending.
    const firstReply = await resolveBatchedIntakeReply(conversationId, `${confirmOption}`);
    expect(firstReply).toHaveLength(1);
    expect(firstReply[0].kind).toBe("identity_anomaly");

    const stillOpen = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const unsolicitedStillPending = stillOpen.find((r) => r.kind === "unsolicited_document")!;
    expect(unsolicitedStillPending.status).toBe("pending");

    // With only one group left open, the client can now answer it with a
    // plain "כן"/"לא" — the graceful single-confirmation fallback.
    const { resolveConfirmationFromReply } = await import("./pendingConfirmations");
    const secondReply = await resolveConfirmationFromReply(conversationId, "לא");
    expect(secondReply).not.toBeNull();
    expect(secondReply!.kind).toBe("unsolicited_document");
    expect(secondReply!.status).toBe("declined");
  });
});

// An immediate correction message (needs_resend — never grouped/delayed,
// unlike identity_anomaly/unsolicited_document above) must never interfere
// with the separate 2-minute silence-window summary: the client fixing a
// problem and then continuing to send valid documents should still get
// exactly one correct, non-duplicated summary once things go quiet.
describe("an immediate correction message never blocks or duplicates the later 2-minute summary", () => {
  it("sends the resend request right away, then — once a valid document follows and the window elapses — exactly one correct summary", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const { runScheduledTasks } = await import("./scheduler");

    // A blurry/unreadable document — immediate, ungrouped correction.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.2,
      matchedRequirementId: null,
      matchConfidence: 0,
      readabilityIssue: "blurry",
      readabilityIssueDetail: "התמונה מטושטשת מדי לקריאה",
      suspectedDocumentType: "תעודת זהות",
      clientMessageIfProblematic: "לא הצלחתי לאמת את תעודת הזהות מכיוון שהתמונה מטושטשת. נא לשלוח צילום חדש, ברור ומלא.",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "blurry_id.jpg", null, Buffer.from("blurry-bytes"), "image/jpeg", "wamid.corr.1");

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const correctionBody = sendTextMessage.mock.calls[0][2] as string;
    expect(correctionBody).toContain("מטושטשת");
    sendTextMessage.mockClear();

    // The client corrects course and sends a genuinely valid document for
    // the OTHER open requirement — approved silently, no per-document reply.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "דרכון",
      identificationConfidence: 0.95,
      matchedRequirementId: (await db.select().from(schema.collectionRequestRequirements).where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId)))
        .find((r) => r.name === "דרכון")!.id,
      matchConfidence: 0.95,
      extractedPersonName: "רז שלום",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "passport.jpg", null, Buffer.from("passport-bytes"), "image/jpeg", "wamid.corr.2");
    expect(sendTextMessage).not.toHaveBeenCalled(); // still silent

    // Window elapses — the cron-style sweep (same path scheduler.ts uses)
    // finds it due and sends exactly one summary.
    await db.update(schema.conversations).set({ pendingCaseReviewAt: new Date(Date.now() - 1000) }).where(eq(schema.conversations.id, conversationId));
    const result = await runScheduledTasks(orgId);
    expect(result.caseStatusReviewsRun).toBe(1);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const summaryBody = sendTextMessage.mock.calls[0][2] as string;
    expect(summaryBody).toContain("דרכון"); // received
    expect(summaryBody).toContain("תעודת זהות"); // still missing — the blurry one was never approved
    sendTextMessage.mockClear();

    // Running the sweep again must never resend the same summary.
    const secondResult = await runScheduledTasks(orgId);
    expect(secondResult.caseStatusReviewsRun).toBe(0);
    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// Regression: a real production incident where the client received the
// exact same combined message twice. Root cause, confirmed from
// production logs: two independent triggers (two scheduleAfterResponse
// timers, from two groups created moments apart) both called
// flushDueIntakeNotifications for the same request within ~100ms of each
// other; the old implementation read the still-unnotified rows, sent, and
// only *then* marked them notified — leaving a window where a second,
// concurrent call could read the exact same unnotified rows before the
// first call's update landed, and send the same message again.
describe("flushDueIntakeNotifications never sends the same combined message twice", () => {
  it("two concurrent flush calls for the same request only ever result in one real send", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const { createOrMergeIdentityAnomalyConfirmation } = await import("./documentIdentityVerification");
    const { createUnsolicitedDocumentConfirmation } = await import("./documentIntakeReview");
    const [idDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "id.jpg", status: "identity_anomaly_pending_confirmation" })
      .returning();
    const [invoiceDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "invoice1.pdf", status: "unsolicited_pending_confirmation" })
      .returning();

    // Two groups created moments apart, exactly as conversationActions.ts
    // creates them immediately at intake time — this test targets
    // flushDueIntakeNotifications's own atomicity directly, independent of
    // how the groups got there.
    await createOrMergeIdentityAnomalyConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: idDoc.id,
      anomaly: { kind: "name_mismatch", confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null },
      documentType: "תעודת זהות",
      matchedRequirementId: null,
      extractedPersonName: null,
      extractedCompanyName: null,
      clientName: "",
    });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: invoiceDoc.id,
      documentType: "חשבונית מס",
    });

    await db
      .update(schema.pendingConfirmations)
      .set({ notifyAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    // Two flush calls racing for the exact same request, exactly as
    // happened in production (two separate scheduleAfterResponse timers
    // firing moments apart). Only one may actually claim and send.
    const [resultA, resultB] = await Promise.all([
      flushDueIntakeNotifications(orgId, requestId),
      flushDueIntakeNotifications(orgId, requestId),
    ]);
    const results = [resultA, resultB];
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(results.filter((r) => !r.sent)).toHaveLength(1);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);

    // A third call (e.g. the cron backstop, later) finds nothing left to
    // do — everything is already notified.
    const resultC = await flushDueIntakeNotifications(orgId, requestId);
    expect(resultC).toEqual({ sent: false, groupCount: 0 });
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});

// Decision-engine "level 3" principle: when a request's documents don't
// all point to one person (two or more genuinely distinct identities, not
// just one outlier), the combined message should name that pattern up
// front instead of the generic "a few things to double check" opener.
describe("case-wide identity split wording", () => {
  it("uses the whole-case 'more than one person' opener when 2+ distinct identities are flagged together", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const { createOrMergeIdentityAnomalyConfirmation } = await import("./documentIdentityVerification");
    const [docA] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.jpg", status: "identity_anomaly_pending_confirmation" })
      .returning();
    const [docB] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "b.jpg", status: "identity_anomaly_pending_confirmation" })
      .returning();

    await createOrMergeIdentityAnomalyConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: docA.id,
      anomaly: { kind: "name_mismatch", confident: true, conflictingName: "אורית לוי", maskedIdNumber: null },
      documentType: "תעודת זהות",
      matchedRequirementId: null,
      extractedPersonName: null,
      extractedCompanyName: null,
      clientName: "",
    });
    await createOrMergeIdentityAnomalyConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: docB.id,
      anomaly: { kind: "name_mismatch", confident: true, conflictingName: "משה גולן", maskedIdNumber: null },
      documentType: "רישיון נהיגה",
      matchedRequirementId: null,
      extractedPersonName: null,
      extractedCompanyName: null,
      clientName: "",
    });

    await db
      .update(schema.pendingConfirmations)
      .set({ notifyAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await flushDueIntakeNotifications(orgId, requestId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("יותר מאדם אחד");
    expect(body).toContain("אורית לוי");
    expect(body).toContain("משה גולן");

    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);
  });

  it("does not use the whole-case opener for a single outlier against an otherwise-consistent request", async () => {
    const { orgId, clientId, requestId } = await seedRequest();
    const { createOrMergeIdentityAnomalyConfirmation } = await import("./documentIdentityVerification");
    const { createUnsolicitedDocumentConfirmation } = await import("./documentIntakeReview");
    const [docA] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "a.jpg", status: "identity_anomaly_pending_confirmation" })
      .returning();
    const [docB] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "invoice.pdf", status: "unsolicited_pending_confirmation" })
      .returning();

    await createOrMergeIdentityAnomalyConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: docA.id,
      anomaly: { kind: "name_mismatch", confident: true, conflictingName: "אורית לוי", maskedIdNumber: null },
      documentType: "תעודת זהות",
      matchedRequirementId: null,
      extractedPersonName: null,
      extractedCompanyName: null,
      clientName: "",
    });
    // A second group, but a *different kind* (unsolicited, not a second
    // identity) — only one distinct identity is in question here, so the
    // generic opener stays correct.
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: docB.id,
      documentType: "חשבונית מס",
    });

    await db
      .update(schema.pendingConfirmations)
      .set({ notifyAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await flushDueIntakeNotifications(orgId, requestId);

    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).not.toContain("יותר מאדם אחד");
    expect(body).toContain("מצאתי כמה מסמכים שדורשים הבהרה");
  });
});
