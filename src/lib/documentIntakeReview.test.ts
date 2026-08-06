import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { AUTO_APPROVE_CONFIDENCE, type DocumentClassification } from "@/lib/ai/documentClassifier";
import { flushDueIntakeNotifications, resolveConfirmationFromReply } from "@/lib/pendingConfirmations";

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
  };
});

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
    moveDriveFile: vi.fn(async () => {}),
    trashDriveFolder: vi.fn(async () => {}),
    uploadDriveFile: vi.fn(async (_token: string, options: { name: string; parentId: string }) => {
      const id = `file-${nextId++}`;
      fakeFiles.push({ id, name: options.name, parentId: options.parentId });
      return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
    }),
  };
});

const {
  resolveDocumentIntakeOutcome,
  createUnsolicitedDocumentConfirmation,
  createClarificationRequest,
  applyUnsolicitedConfirmationDecision,
  applyClarificationReply,
  sendConfirmationRemindersAndEscalate,
} = await import("./documentIntakeReview");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  fakeFolders = [];
  fakeFiles = [];
  getValidAccessToken.mockResolvedValue("fake-token");
  sendTextMessage.mockReset();
  sendTemplateMessage.mockReset();
});

// ---------------------------------------------------------------------------
// resolveDocumentIntakeOutcome — pure, no DB
// ---------------------------------------------------------------------------

describe("resolveDocumentIntakeOutcome", () => {
  const readable = { supported: true, readable: true };

  it("Case 1 — matched: a confident match against an open requirement", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: "req-1",
      confidence: 0.9,
    };
    expect(resolveDocumentIntakeOutcome(classification, ["req-1", "req-2"])).toEqual({
      kind: "matched",
      requirementId: "req-1",
      confidence: 0.9,
    });
  });

  it("Case 2 — unsolicited: AI identified it, but it doesn't match anything open, even with multiple requirements still outstanding", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: null,
      confidence: 0,
      aiRan: true,
      aiIdentified: true,
      aiDocumentType: "חשבונית מס קבלה",
    };
    expect(resolveDocumentIntakeOutcome(classification, ["req-1", "req-2"])).toEqual({
      kind: "unsolicited",
      documentType: "חשבונית מס קבלה",
    });
  });

  it("Case 2 takes priority over the sole-outstanding fallback — a confident 'this is something else' is never overridden by 'only one thing it could be'", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: null,
      confidence: 0,
      aiRan: true,
      aiIdentified: true,
      aiDocumentType: "קבלה על שירותי ניקיון",
    };
    // Only one requirement left — the old fallback would have forced a
    // match here; Case 2 must win instead.
    expect(resolveDocumentIntakeOutcome(classification, ["req-1"])).toEqual({
      kind: "unsolicited",
      documentType: "קבלה על שירותי ניקיון",
    });
  });

  it("Case 3 — unrecognized: the AI ran but couldn't identify it, multiple requirements open", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: null,
      confidence: 0,
      aiRan: true,
      aiIdentified: false,
      aiDocumentType: null,
    };
    expect(resolveDocumentIntakeOutcome(classification, ["req-1", "req-2"])).toEqual({ kind: "unrecognized" });
  });

  it("sole-outstanding fallback still applies when there is no AI signal at all (filename-only path)", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: null,
      confidence: 0,
    };
    const result = resolveDocumentIntakeOutcome(classification, ["req-1"]);
    expect(result).toEqual({ kind: "matched", requirementId: "req-1", confidence: AUTO_APPROVE_CONFIDENCE });
  });

  it("a weak filename match below the auto-approve bar falls through to unrecognized rather than a low-confidence 'match'", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: "req-1",
      confidence: 0.3,
    };
    expect(resolveDocumentIntakeOutcome(classification, ["req-1", "req-2"])).toEqual({ kind: "unrecognized" });
  });

  it("never guesses when the AI found nothing and more than one requirement is still open", () => {
    const classification: DocumentClassification = {
      ...readable,
      matchedRequirementId: null,
      confidence: 0,
      aiRan: true,
      aiIdentified: false,
    };
    expect(resolveDocumentIntakeOutcome(classification, ["req-1", "req-2"])).toEqual({ kind: "unrecognized" });
  });
});

// ---------------------------------------------------------------------------
// Integration: confirmation creation + application + reminders/escalation
// ---------------------------------------------------------------------------

async function seedRequest(options?: {
  businessHoursAlwaysOpen?: boolean;
  confirmationMaxReminders?: number;
  whatsappPhoneNumberId?: string;
}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      documentCollectionEnabled: true,
      ...(options?.businessHoursAlwaysOpen
        ? { businessHoursStart: "00:00", businessHoursEnd: "23:59", businessDays: "0,1,2,3,4,5,6" }
        : {}),
      ...(options?.confirmationMaxReminders !== undefined
        ? { confirmationMaxReminders: options.confirmationMaxReminders }
        : {}),
      ...(options?.whatsappPhoneNumberId ? { whatsappPhoneNumberId: options.whatsappPhoneNumberId } : {}),
    })
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
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [document] = await db
    .insert(schema.documents)
    .values({
      organizationId: org.id,
      collectionRequestId: request.id,
      fileName: "image_wamid.abc.jpg",
      status: "unsolicited_pending_confirmation",
      pendingFileContent: Buffer.from("fake-bytes"),
      pendingFileMimeType: "image/jpeg",
    })
    .returning();

  return {
    orgId: org.id,
    clientId: client.id,
    requestId: request.id,
    conversationId: conversation.id,
    requirementId: requirement.id,
    documentId: document.id,
  };
}

// Smart notification grouping: createUnsolicitedDocumentConfirmation holds
// the question (notifyAfter set, notifiedAt/nextReminderAt null) until
// flushDueIntakeNotifications actually sends it — this forces that flush
// immediately instead of waiting for the real grouping window, the same
// "force it due" pattern the reminder tests below already use.
async function forceFlush(orgId: string, requestId: string) {
  await db
    .update(schema.pendingConfirmations)
    .set({ notifyAfter: new Date(Date.now() - 1000) })
    .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
  return flushDueIntakeNotifications(orgId, requestId);
}

describe("createUnsolicitedDocumentConfirmation / createClarificationRequest", () => {
  it("creates a pending confirmation (held for the grouping window) with the document id in its payload", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest();
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית מס קבלה",
    });

    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(row.kind).toBe("unsolicited_document");
    expect(row.status).toBe("pending");
    expect((row.payload as { documentIds: string[] }).documentIds).toEqual([documentId]);
    // Held, not sent yet — nextReminderAt (and notifiedAt) are only set once
    // flushDueIntakeNotifications actually dispatches the question.
    expect(row.notifiedAt).toBeNull();
    expect(row.nextReminderAt).toBeNull();
    expect(row.notifyAfter).not.toBeNull();
  });

  it("flushing sends the question and only then schedules a reminder", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית מס קבלה",
    });

    const result = await forceFlush(orgId, requestId);
    expect(result).toEqual({ sent: true, groupCount: 1 });

    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(row.notifiedAt).not.toBeNull();
    expect(row.nextReminderAt).not.toBeNull();
    expect(row.groupIndex).toBe(0);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it("clarification request payload references the document, no yes/no options in a matching name", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest();
    await createClarificationRequest({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId });

    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(row.kind).toBe("document_clarification");
    expect((row.payload as { documentId: string }).documentId).toBe(documentId);
  });

  // Smart notification grouping (production report: two unrelated invoices
  // produced two separate WhatsApp messages) — several unsolicited
  // documents of the exact same type must fold into one still-unnotified
  // group, not open a question per file.
  it("two documents of the same unrelated type merge into one group and produce exactly one WhatsApp message", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const [secondDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "invoice2.jpg", status: "unsolicited_pending_confirmation" })
      .returning();
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });

    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId, documentType: "חשבונית מס" });
    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: secondDoc.id, documentType: "חשבונית מס" });

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as { documentIds: string[] }).documentIds).toEqual([documentId, secondDoc.id]);
    expect(rows[0].question).toContain("2");

    await forceFlush(orgId, requestId);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);
  });

  it("a document of a different unrelated type does not merge into an existing group of another type", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const [secondDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "other.jpg", status: "unsolicited_pending_confirmation" })
      .returning();

    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId, documentType: "חשבונית מס" });
    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: secondDoc.id, documentType: "אישור ניהול חשבון" });

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(rows).toHaveLength(2);
  });

  it("a new document of the same type arriving after the group's question was already sent starts a fresh group instead of reopening the sent one", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId, documentType: "חשבונית מס" });
    await forceFlush(orgId, requestId);
    expect(sendTextMessage).toHaveBeenCalledTimes(1);

    const [thirdDoc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "invoice-later.jpg", status: "unsolicited_pending_confirmation" })
      .returning();
    await createUnsolicitedDocumentConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: thirdDoc.id, documentType: "חשבונית מס" });

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(rows).toHaveLength(2);
    const alreadySent = rows.find((r) => r.notifiedAt !== null)!;
    const stillPending = rows.find((r) => r.notifiedAt === null)!;
    expect((alreadySent.payload as { documentIds: string[] }).documentIds).toEqual([documentId]);
    expect((stillPending.payload as { documentIds: string[] }).documentIds).toEqual([thirdDoc.id]);
    // No second message yet — the new document only opened a new pending
    // group, it didn't reopen or resend the one already delivered.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
  });
});

// UX rewrite: short, warm, human wording — no formal/legal phrasing, no
// repeating the same fact twice, and the document type shown is always
// whatever the AI actually identified (never a hardcoded example type).
describe("unsolicited-document question wording", () => {
  it("is short and free of formal phrasing, using the real identified document type", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest();
    // Deliberately not "חשבונית" (used everywhere else in this file) —
    // proves the type comes from the call's own documentType argument
    // (itself sourced from the AI's own classification), never a
    // hardcoded literal in the wording function.
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "אישור ניהול חשבון",
    });

    const [row] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(row.question).toContain("אישור ניהול חשבון");
    expect(row.question).not.toContain("זיהינו ש");
    expect(row.question).not.toContain("ברשימת המסמכים שהתבקשת לשלוח");
    expect(row.question.length).toBeLessThan(100);
  });
});

describe("applyUnsolicitedConfirmationDecision", () => {
  it("client confirms intentional — uploads to the existing client folder, names the file by the identified type, never a duplicate folder", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest();
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית מס קבלה",
    });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await db.update(schema.pendingConfirmations).set({ status: "confirmed" }).where(eq(schema.pendingConfirmations.id, confirmation.id));
    await applyUnsolicitedConfirmationDecision({ ...confirmation, status: "confirmed", conversationId });

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(doc.status).toBe("unsolicited_approved");
    expect(doc.fileName).toBe("חשבונית מס קבלה.jpg");
    expect(doc.googleDriveFileId).not.toBeNull();
    // Exactly one month folder + one client folder — the existing folder
    // resolved by ensureCollectionRequestDriveFolder, never a second one.
    expect(fakeFolders).toHaveLength(2);
    const clientFolders = fakeFolders.filter((f) => f.properties?.centroClientId === clientId);
    expect(clientFolders).toHaveLength(1);
  });

  it("client says it was a mistake — never uploaded, pending bytes cleared, marked rejected", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest();
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית מס קבלה",
    });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyUnsolicitedConfirmationDecision({ ...confirmation, status: "declined", conversationId });

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(doc.status).toBe("unsolicited_rejected");
    expect(doc.pendingFileContent).toBeNull();
    expect(fakeFiles).toHaveLength(0);
  });
});

describe("applyClarificationReply", () => {
  it("client explains what it is, and it matches an open requirement — approved and uploaded, same as any other match", async () => {
    const { orgId, clientId, requestId, conversationId, requirementId, documentId } = await seedRequest();
    await createClarificationRequest({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyClarificationReply({ ...confirmation, conversationId }, "תעודת זהות שלי");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(doc.status).toBe("approved");
    expect(doc.requirementId).toBe(requirementId);
    expect(doc.googleDriveFileId).not.toBeNull();
  });

  it("client's explanation doesn't match anything open — falls through to an unsolicited-style confirmation using their own words", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest();
    await createClarificationRequest({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyClarificationReply({ ...confirmation, conversationId }, "זו קבלה על תיקון מזגן");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    // Still not uploaded, still not needs_review — a fresh question was asked instead.
    expect(doc.status).toBe("unsolicited_pending_confirmation");
    expect(doc.googleDriveFileId).toBeNull();

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const unsolicited = rows.find((r) => r.kind === "unsolicited_document");
    expect(unsolicited).toBeDefined();
    expect((unsolicited!.payload as { documentType: string }).documentType).toBe("זו קבלה על תיקון מזגן");
  });
});

describe("sendConfirmationRemindersAndEscalate", () => {
  it("resends the question and increments remindersSent for a due, unanswered confirmation", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ businessHoursAlwaysOpen: true });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    // Force it due now instead of waiting for the real interval.
    await db.update(schema.pendingConfirmations).set({ nextReminderAt: new Date(Date.now() - 1000) }).where(eq(schema.pendingConfirmations.id, confirmation.id));

    const result = await sendConfirmationRemindersAndEscalate(orgId);
    expect(result.reminded).toBe(1);
    expect(result.escalated).toBe(0);

    const [after] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.id, confirmation.id));
    expect(after.remindersSent).toBe(1);
    expect(after.status).toBe("pending"); // still open — reminded, not resolved
  });

  it("escalates to needs_review — and only needs_review, never approved or dropped — once the reminder budget is exhausted with no reply", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ businessHoursAlwaysOpen: true, confirmationMaxReminders: 2 });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await db
      .update(schema.pendingConfirmations)
      .set({ remindersSent: 2, nextReminderAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.id, confirmation.id));

    const result = await sendConfirmationRemindersAndEscalate(orgId);
    expect(result.reminded).toBe(0);
    expect(result.escalated).toBe(1);

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(doc.status).toBe("needs_review");

    const [after] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.id, confirmation.id));
    expect(after.escalatedAt).not.toBeNull();
    expect(after.nextReminderAt).toBeNull();
  });

  it("is a no-op for a confirmation that isn't due yet", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ businessHoursAlwaysOpen: true });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    const result = await sendConfirmationRemindersAndEscalate(orgId);
    expect(result).toEqual({ reminded: 0, escalated: 0 });
  });

  it("never re-escalates an already-escalated confirmation", async () => {
    const { orgId, clientId, requestId, documentId } = await seedRequest({ businessHoursAlwaysOpen: true, confirmationMaxReminders: 1 });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await db
      .update(schema.pendingConfirmations)
      .set({ remindersSent: 1, nextReminderAt: new Date(Date.now() - 1000), escalatedAt: new Date() })
      .where(eq(schema.pendingConfirmations.id, confirmation.id));

    const result = await sendConfirmationRemindersAndEscalate(orgId);
    expect(result).toEqual({ reminded: 0, escalated: 0 });
  });

  it("defers a reminder to the next business-hours opening instead of leaving it stuck while the office is closed", async () => {
    // Default hours: 09:00-18:00, Sun-Thu, Asia/Jerusalem (schema defaults —
    // NOT businessHoursAlwaysOpen).
    const { orgId, clientId, requestId, documentId } = await seedRequest();
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    vi.useFakeTimers();
    try {
      // Sunday 06:00 Israel local time — before the 09:00 opening.
      vi.setSystemTime(new Date("2026-01-11T04:00:00Z"));
      await db
        .update(schema.pendingConfirmations)
        .set({ nextReminderAt: new Date(Date.now() - 1000) })
        .where(eq(schema.pendingConfirmations.id, confirmation.id));

      const result = await sendConfirmationRemindersAndEscalate(orgId);
      // Never actually attempted — not just gated after the fact.
      expect(result).toEqual({ reminded: 0, escalated: 0 });

      const [after] = await db
        .select()
        .from(schema.pendingConfirmations)
        .where(eq(schema.pendingConfirmations.id, confirmation.id));
      expect(after.remindersSent).toBe(0);
      expect(after.status).toBe("pending");
      // Rescheduled to 09:00 Israel local the same day (07:00 UTC in
      // winter) — not left stuck in the past for every future tick to keep
      // failing on (the real production gap this closes: a once-daily cron
      // that never happens to land inside business hours would otherwise
      // never send this reminder at all).
      expect(after.nextReminderAt?.toISOString()).toBe("2026-01-11T07:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The messaging fix: the confirmation/clarification question — and the
// thank-you that follows a "yes" — must actually reach the client over
// WhatsApp. Before this fix, both were silently dropped: an "ai" sender with
// no matching pre-approved template returns deliveryStatus "no_template"
// (dynamic text is never in TEMPLATE_BY_BODY), and even past that,
// trigger:"automated" (the old default) is held outside business hours.
// These tests prove the real Cloud API call is actually attempted — via
// free-form text, bypassing both blockers — not just that a DB row gets
// created.
// ---------------------------------------------------------------------------

describe("WhatsApp delivery of the confirmation question (the messaging fix)", () => {
  it("sends the question as free-form text, bypassing the no-template block and the business-hours gate", async () => {
    // Deliberately NOT businessHoursAlwaysOpen — proves trigger:\"manual\"
    // really does bypass that gate for this immediate, reactive send.
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      whatsappPhoneNumberId: "phone-1",
    });
    sendTextMessage.mockResolvedValueOnce({ messageId: "wamid.out.1" });

    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית מס קבלה",
    });
    await forceFlush(orgId, requestId);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTemplateMessage).not.toHaveBeenCalled();

    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(message.deliveryStatus).toBe("sent");
    expect(message.whatsappMessageId).toBe("wamid.out.1");
  });

  it("sends the clarification question the same way", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      whatsappPhoneNumberId: "phone-1",
    });
    sendTextMessage.mockResolvedValueOnce({ messageId: "wamid.out.2" });

    await createClarificationRequest({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(message.deliveryStatus).toBe("sent");
  });

  it("sends the thank-you after a 'yes' reply as free-form text too", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      whatsappPhoneNumberId: "phone-1",
    });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    await forceFlush(orgId, requestId);
    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyUnsolicitedConfirmationDecision({ ...confirmation, status: "confirmed", conversationId });

    // One for the original question, one for the thank-you.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    const sentMessages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(sentMessages.every((m) => m.deliveryStatus === "sent")).toBe(true);
  });

  it("reminder resend also goes out as free-form text (no pre-approved template exists for this dynamic question)", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      businessHoursAlwaysOpen: true,
      whatsappPhoneNumberId: "phone-1",
    });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    await forceFlush(orgId, requestId);
    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await db
      .update(schema.pendingConfirmations)
      .set({ nextReminderAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.id, confirmation.id));

    const result = await sendConfirmationRemindersAndEscalate(orgId);

    expect(result.reminded).toBe(1);
    // Original question (via flush) + the reminder resend, both free-form text.
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
    const sentMessages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(sentMessages).toHaveLength(2);
  });

  it("a WhatsApp send failure doesn't block the confirmation from being flushed, is recorded on the message row, and stays pending for the next reminder to retry", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      whatsappPhoneNumberId: "phone-1",
    });
    const { WhatsAppSendError } = await import("@/lib/whatsapp/send");
    sendTextMessage.mockRejectedValueOnce(new WhatsAppSendError("simulated Meta failure"));

    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });
    await expect(forceFlush(orgId, requestId)).resolves.not.toThrow();

    const [row] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(row.status).toBe("pending");
    expect(row.notifiedAt).not.toBeNull();
    expect(row.nextReminderAt).not.toBeNull();

    const [message] = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(message.deliveryStatus).toBe("failed");
  });

  it("a duplicate reply delivery only resolves and acts on the confirmation once — no double upload", async () => {
    const { orgId, clientId, requestId, conversationId, documentId } = await seedRequest({
      whatsappPhoneNumberId: "phone-1",
    });
    sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
    await createUnsolicitedDocumentConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId,
      documentType: "חשבונית",
    });

    const first = await resolveConfirmationFromReply(conversationId, "כן");
    expect(first).not.toBeNull();
    await applyUnsolicitedConfirmationDecision({ ...first!, conversationId });

    // A redelivered copy of the same inbound "כן" webhook: nothing is left
    // in "pending" status to match, so this must be a no-op, not a second
    // upload/thank-you.
    const second = await resolveConfirmationFromReply(conversationId, "כן");
    expect(second).toBeNull();

    expect(fakeFiles).toHaveLength(1);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(doc.status).toBe("unsolicited_approved");
  });
});
