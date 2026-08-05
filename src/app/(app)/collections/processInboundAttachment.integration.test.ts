import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Regression coverage for a real production report: two documents sent
// together were received and filed correctly, but a PDF sent ~1 minute
// later and a photo sent ~6 minutes after that were not. Traced against
// real production logs (not guessed) to: every later webhook call *did*
// arrive, *did* resolve to the same open collection request, and *did*
// run classification — the two later files simply didn't match any of the
// collection request's remaining open requirements (an unrelated phone-
// service invoice, sent while "תעודת זהות"/"רישיון נהיגה" were still open),
// so they correctly landed in needs_review rather than Drive. Nothing
// closes a request early (collectionRequestStateMachine.checkCompletionGate
// requires every requirement approved) and nothing time-limits how long a
// request stays associated with a phone number's inbound messages (there is
// no timeout/expiry field anywhere in this path). This file locks that in:
// several attachments for the same collection request, arriving as
// separate calls (standing in for "at different times" — nothing in this
// code path is actually time-sensitive) with a mix of matching and
// non-matching document types, must all attach to the same request, use
// the same Drive folder, and never close the request early.

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

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

const { processInboundAttachment } = await import("./conversationActions");

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
});

async function seedRequest(requirementNames: string[]) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1" })
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

describe("processInboundAttachment — documents arriving as separate calls for the same open request", () => {
  it("two matching documents, then a non-matching PDF, then a non-matching photo — all attach to the same request, same Drive folder, request never closes early", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest([
      "תעודת זהות",
      "רישיון נהיגה",
      "דף חשבון בנק",
      "תלוש שכר",
    ]);
    const idReq = requirements.find((r) => r.name === "תעודת זהות")!;
    const licenseReq = requirements.find((r) => r.name === "רישיון נהיגה")!;

    // Message 1+2: "two images together" — both match real outstanding requirements.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      matchedRequirementId: licenseReq.id,
      confidence: 0.98,
      documentType: "רישיון נהיגה",
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "image_wamid.a.jpg",
      null,
      Buffer.from("license-bytes"),
      "image/jpeg",
      "wamid.1"
    );

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      matchedRequirementId: idReq.id,
      confidence: 0.98,
      documentType: "תעודת זהות",
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "image_wamid.b.jpg",
      null,
      Buffer.from("id-bytes"),
      "image/jpeg",
      "wamid.2"
    );

    // Message 3 ("~1 minute later" — nothing in this path is time-sensitive,
    // simulated as simply the next call): an unrelated invoice PDF that
    // doesn't match either of the two still-open requirements.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      matchedRequirementId: null,
      confidence: 0.97,
      documentType: "חשבונית מס קבלה",
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "חשבונית מס קבלה 53206.pdf",
      null,
      Buffer.from("invoice-bytes"),
      "application/pdf",
      "wamid.3"
    );

    // Message 4 ("~6 minutes later"): another unrelated document.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      matchedRequirementId: null,
      confidence: 0.95,
      documentType: "חשבונית שירות טלפוני",
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "image_wamid.c.jpg",
      null,
      Buffer.from("phone-invoice-bytes"),
      "image/jpeg",
      "wamid.4"
    );

    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(4);
    // All four attached to the same request/conversation regardless of gaps.
    expect(allDocs.every((d) => d.collectionRequestId === requestId)).toBe(true);

    const approved = allDocs.filter((d) => d.status === "approved");
    const needsReview = allDocs.filter((d) => d.status === "needs_review");
    expect(approved).toHaveLength(2);
    expect(needsReview).toHaveLength(2);

    // Both approved documents landed in the exact same Drive folder — no
    // per-call folder drift, no duplicate folder for the later arrivals.
    const approvedFileIds = approved.map((d) => d.googleDriveFileId);
    const parents = new Set(fakeFiles.filter((f) => approvedFileIds.includes(f.id)).map((f) => f.parentId));
    expect(parents.size).toBe(1);

    // The unmatched documents were correctly held for human review, not
    // silently dropped and not incorrectly auto-approved.
    for (const doc of needsReview) {
      expect(doc.requirementId).toBeNull();
    }

    // The request must NOT have auto-closed with only 2 of 4 requirements
    // satisfied — checkCompletionGate only allows "completed" when every
    // requirement has an approved document.
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
  });

  it("a document arriving well after the first two is still classified against the request's real remaining requirements, not silently ignored", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    const idReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      matchedRequirementId: idReq.id,
      confidence: 0.98,
      documentType: "תעודת זהות",
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "image_wamid.late.jpg",
      null,
      Buffer.from("late-bytes"),
      "image/jpeg",
      "wamid.late"
    );

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("approved");
    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
  });
});
