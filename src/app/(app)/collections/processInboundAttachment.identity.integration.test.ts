import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

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
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: vi.fn(),
  };
});

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

const { processInboundAttachment } = await import("./conversationActions");
const { runCaseReview } = await import("@/lib/caseReview");

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
});

async function seedRequest(requirementNames: string[], clientName = "נועם שלום") {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: "phone-1" })
    .returning();
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

    // "Centro checks the case, not the document" — nothing asked yet
    // while collection might still be in progress; the document is only
    // held (deferredReviewKind set), no question sent.
    expect(doc.deferredReviewKind).toBe("identity_anomaly");
    const confirmationsBeforeReview = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmationsBeforeReview).toHaveLength(0);

    // Only once the client signals they're done does the whole case get
    // reviewed — this sends the question and flushes immediately.
    await runCaseReview(orgId, clientId, requestId);

    const [confirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.kind).toBe("identity_anomaly");
    expect(confirmation.question).toContain("ישראל ישראלי");
    // The question actually went out over WhatsApp — not silently dropped.
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
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
  });
});
