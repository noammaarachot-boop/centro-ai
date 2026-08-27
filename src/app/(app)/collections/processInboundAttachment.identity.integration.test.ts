import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { seedApprovedWhatsAppTemplates } from "@/test/whatsappFixtures";

// Smart identity/consistency verification (src/lib/documentIdentityVerification.ts)
// end-to-end through the real intake pipeline: a document of exactly the
// right type can still be the wrong person's — this proves that case is
// caught before Drive upload, not after, and that a long run of correct
// documents correctly flags a single outlier among them.

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

const { processInboundAttachment } = await import("./conversationActions");
const { flushDueIntakeNotifications } = await import("@/lib/pendingConfirmations");

// Identity-anomaly confirmations are asked about immediately (not deferred
// to whole-case-review time) but still held for the short notification-
// grouping window (pendingConfirmations.ts) — forces that flush
// immediately for tests that need to observe the send.
async function forceFlush(orgId: string, requestId: string) {
  await db
    .update(schema.pendingConfirmations)
    .set({ notifyAfter: new Date(Date.now() - 1000) })
    .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
  return flushDueIntakeNotifications(orgId, requestId);
}

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
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

async function seedRequest(requirementNames: string[], clientName = "נועם שלום") {
  const [org] = await db
    .insert(schema.organizations)
    // Suffixed with a fresh uuid — Phase 1.6's unique constraint on this
    // column (see caseReview.test.ts's identical comment).
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
    .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: clientName, phone: "+972500000000" })
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
  const requirements = [];
  for (const name of requirementNames) {
    const [req] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name })
      .returning();
    requirements.push(req);
  }
  return { orgId: org.id, clientId: client.id, requestId: request.id, conversationId: conversation.id, requirements };
}

describe("processInboundAttachment — smart identity/consistency verification", () => {
  it("scenario 1: document matches the requirement and the client's name — approved and uploaded normally", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.98,
      extractedPersonName: "נועם שלום",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });

    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.1");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("approved");
    expect(doc.googleDriveFileId).not.toBeNull();
    expect(doc.extractedPersonName).toBe("נועם שלום");
  });

  it("scenario 2: correct document type, but the name on it belongs to someone else — held for confirmation, never uploaded", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.98,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "222222226",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });

    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.2");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("identity_anomaly_pending_confirmation");
    expect(doc.googleDriveFileId).toBeNull();
    expect(doc.requirementId).toBeNull();
    expect(fakeFiles).toHaveLength(0);

    // Asked about immediately — not deferred to whole-case-review time —
    // but still held for the short notification-grouping window rather
    // than sent as its own standalone message the instant this one
    // document arrives.
    expect(doc.deferredReviewKind).toBeNull();
    const [confirmationBeforeFlush] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmationBeforeFlush.kind).toBe("identity_anomaly");
    expect(confirmationBeforeFlush.notifiedAt).toBeNull();
    expect(sendInteractiveButtonsMessage).not.toHaveBeenCalled();

    await forceFlush(orgId, requestId);

    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.kind).toBe("identity_anomaly");
    expect(confirmation.question).toContain("ישראל ישראלי");
    // The question actually went out over WhatsApp (a solo group, via
    // Interactive Reply Buttons) — not silently dropped.
    expect(sendInteractiveButtonsMessage).toHaveBeenCalledTimes(1);
  });

  it("scenario 3: ten documents for the client, then one for a different person — the outlier alone is flagged, the other ten are approved", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלושי שכר"]);
    const reqId = requirements[0].id;

    for (let i = 0; i < 10; i++) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.9,
        matchedRequirementId: reqId,
        matchConfidence: 0.9,
        extractedPersonName: "נועם שלום",
        extractedIdNumber: "111111118",
        extractedCompanyName: null,
        identityExtractionConfidence: 0.9,
      });
      await processInboundAttachment(
        orgId,
        requestId,
        conversationId,
        clientId,
        `payslip-${i}.jpg`,
        null,
        Buffer.from(`bytes-${i}`),
        "image/jpeg",
        `wamid.s3.${i}`
      );
    }

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תלוש שכר",
      identificationConfidence: 0.9,
      matchedRequirementId: reqId,
      matchConfidence: 0.9,
      extractedPersonName: "ישראל ישראלי",
      extractedIdNumber: "222222226",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.9,
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "payslip-outlier.jpg",
      null,
      Buffer.from("outlier-bytes"),
      "image/jpeg",
      "wamid.s3.outlier"
    );

    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(11);
    const approved = allDocs.filter((d) => d.status === "approved");
    const anomalies = allDocs.filter((d) => d.status === "identity_anomaly_pending_confirmation");
    expect(approved).toHaveLength(10);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].fileName).toBe("payslip-outlier.jpg");
    // 30s, not the 5s default: this one scenario ingests ELEVEN documents
    // through the full pipeline (ten consistent plus the outlier), where its
    // siblings ingest one or two. It timed out reproducibly in isolation.
    // A timeout is a resource bound, not an assertion — every assertion in
    // this test is unchanged, and the file's own beforeAll already declares
    // 60s for the same reason.
  }, 30_000);

  // Mandatory scenarios #13/#14: ת"ז + ספח (ID card + its matching appendix).
  // No dedicated "linked requirement" mechanism exists for this — it's
  // covered for free by the identity-anomaly engine already comparing
  // every document's extracted ID number against every sibling document's
  // in the same request (buildIdentityReferencePool), regardless of which
  // two requirement types they answer.
  it("scenario 13: ID card + its matching appendix (ספח) — same ID number on both — both approved, no anomaly raised", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "ספח תעודת זהות"]);
    const idReq = requirements.find((r) => r.name === "תעודת זהות")!;
    const appendixReq = requirements.find((r) => r.name === "ספח תעודת זהות")!;

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.98,
      extractedPersonName: "נועם שלום",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.id");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "ספח תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: appendixReq.id,
      matchConfidence: 0.95,
      extractedPersonName: "נועם שלום",
      extractedIdNumber: "111111118", // same number as the ID card
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "appendix.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.appendix");

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.status === "approved")).toBe(true);
    expect(docs.every((d) => d.deferredReviewKind === null)).toBe(true);
  });

  it("scenario 14: appendix (ספח) with a DIFFERENT ID number than the ID card — flagged as an identity anomaly, never uploaded", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "ספח תעודת זהות"]);
    const idReq = requirements.find((r) => r.name === "תעודת זהות")!;
    const appendixReq = requirements.find((r) => r.name === "ספח תעודת זהות")!;

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.98,
      extractedPersonName: "נועם שלום",
      extractedIdNumber: "111111118",
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.id2");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "ספח תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: appendixReq.id,
      matchConfidence: 0.95,
      extractedPersonName: "נועם שלום",
      extractedIdNumber: "999999991", // a different number than the ID card
      extractedCompanyName: null,
      identityExtractionConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "appendix-mismatch.jpg", null, Buffer.from("bytes"), "image/jpeg", "wamid.appendix2");

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    const idDoc = docs.find((d) => d.fileName === "id.jpg")!;
    const appendixDoc = docs.find((d) => d.fileName === "appendix-mismatch.jpg")!;
    expect(idDoc.status).toBe("approved");
    expect(appendixDoc.status).toBe("identity_anomaly_pending_confirmation");
    expect(appendixDoc.googleDriveFileId).toBeNull();

    // Asked about immediately — the pendingConfirmation row already exists
    // right after intake, before any case review or flush.
    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.kind).toBe("identity_anomaly");
    expect(confirmation.question).toContain("1118"); // last-4 of the ID card's number, never the full number
  });
});
