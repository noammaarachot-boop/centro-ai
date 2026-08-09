import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Post-completion intent gate (src/lib/requestReopen.ts) — the real
// production gap this closes: processInboundAttachment's own
// reopenIfCompleted used to run unconditionally the moment any document
// arrived, with no confirmation asked at all. This proves the fix at both
// the pure decision layer (decidePostCompletionGate) and the real
// DB-backed create/apply flow.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

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

const getValidAccessToken = vi.fn();
vi.mock("@/lib/googleAuth/driveTokens", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/driveTokens")>("@/lib/googleAuth/driveTokens");
  return { ...actual, getValidAccessToken: (...args: unknown[]) => getValidAccessToken(...args) };
});

vi.mock("@/lib/googleAuth/drive", async () => {
  const actual = await vi.importActual<typeof import("@/lib/googleAuth/drive")>("@/lib/googleAuth/drive");
  return {
    ...actual,
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
    moveDriveFile: vi.fn(async (_token: string, fileId: string, _from: string, toParentId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.parentId = toParentId;
    }),
    trashDriveFolder: vi.fn(),
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
    sendInteractiveButtonsMessage: vi.fn().mockResolvedValue({ messageId: "wamid.out" }),
    sendTemplateMessage: vi.fn(),
  };
});

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

const { createRequestReopenConfirmation, applyRequestReopenDecision, decidePostCompletionGate, POST_COMPLETION_WINDOW_MS } = await import("./requestReopen");
const { reprocessHeldReopenDocument } = await import("@/app/(app)/collections/conversationActions");
const { resolveConfirmationFromReply } = await import("./pendingConfirmations");

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

describe("decidePostCompletionGate — pure decision core", () => {
  it("falls through when the conversation isn't closed", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "open", hasOpenConfirmations: false, hasAttachment: false, wantsReopen: false, withinPostCompletionWindow: true })
    ).toBe("fall_through");
  });

  it("falls through when a confirmation (most commonly the reopen question itself) is already open", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: true, hasAttachment: true, wantsReopen: false, withinPostCompletionWindow: true })
    ).toBe("fall_through");
  });

  it("stashes an attachment arriving on a closed conversation with nothing pending, within the 48h window", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: false, hasAttachment: true, wantsReopen: false, withinPostCompletionWindow: true })
    ).toBe("stash_attachment");
  });

  it("asks before reopening when the text explicitly references the finished request, within the 48h window", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: false, hasAttachment: false, wantsReopen: true, withinPostCompletionWindow: true })
    ).toBe("ask_reopen");
  });

  it("stays silent for an ordinary unrelated message on a closed conversation, within the 48h window", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: false, hasAttachment: false, wantsReopen: false, withinPostCompletionWindow: true })
    ).toBe("silent");
  });

  // The 48-hour grace window (scenarios 5/6 from the conversational
  // correction layer's own test plan) — total silence past it, regardless
  // of what the message contains, matching the product decision that this
  // mechanism "stops intervening" entirely once the window has elapsed.
  it("stays silent past the 48h window even with an attachment (never stashed)", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: false, hasAttachment: true, wantsReopen: false, withinPostCompletionWindow: false })
    ).toBe("silent");
  });

  it("stays silent past the 48h window even when the text references the finished request", () => {
    expect(
      decidePostCompletionGate({ conversationStatus: "closed", hasOpenConfirmations: false, hasAttachment: false, wantsReopen: true, withinPostCompletionWindow: false })
    ).toBe("silent");
  });

  it("exports a 48-hour window constant", () => {
    expect(POST_COMPLETION_WINDOW_MS).toBe(48 * 60 * 60 * 1000);
  });
});

async function seedCompletedRequest() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: "phone-1" })
    .returning();
  const [client] = await db.insert(schema.clients).values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" }).returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "completed" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "closed" })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id, requirementId: requirement.id, conversationId: conversation.id };
}

describe("createRequestReopenConfirmation / applyRequestReopenDecision", () => {
  it("a document held for a closed request is never uploaded until confirmed — decline leaves the request completed", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedCompletedRequest();
    const [placeholder] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "late.jpg",
        status: "reopen_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
      })
      .returning();

    await createRequestReopenConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: placeholder.id });

    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.kind).toBe("request_reopen");
    expect(confirmation.status).toBe("pending");

    // The client answers "לא" — resolved through the exact same generic
    // yes/no resolver every other confirmation kind uses.
    const resolved = await resolveConfirmationFromReply(conversationId, "לא");
    expect(resolved!.status).toBe("declined");
    await applyRequestReopenDecision(resolved!, reprocessHeldReopenDocument);

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.id, placeholder.id));
    expect(doc.status).toBe("reopen_declined");
    expect(doc.pendingFileContent).toBeNull();
    expect(fakeFiles).toHaveLength(0);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed"); // never touched
  });

  it("confirming reopens the request/conversation and runs the held document through the real intake pipeline", async () => {
    const { orgId, clientId, requestId, conversationId, requirementId } = await seedCompletedRequest();
    const [placeholder] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "late-id.jpg",
        status: "reopen_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
      })
      .returning();

    await createRequestReopenConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: placeholder.id });

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirementId,
      matchConfidence: 0.95,
    });

    const resolved = await resolveConfirmationFromReply(conversationId, "כן");
    expect(resolved!.status).toBe("confirmed");
    await applyRequestReopenDecision(resolved!, reprocessHeldReopenDocument);

    // Post-completion extension flow (src/lib/requestExtension.ts) — even
    // though the held document turned out to be exactly what was missing,
    // a reopened request never auto-completes the instant one document
    // satisfies it: the client may still want to add more, and only an
    // explicit "finished" (or the extension-finished-check confirmation)
    // closes it again.
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("active");
    expect(request.extensionActive).toBe(true);
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("open");

    // The placeholder row itself is gone — replaced by a real, classified
    // document, uploaded to Drive exactly like any normal intake.
    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(1);
    expect(allDocs[0].id).not.toBe(placeholder.id);
    expect(allDocs[0].status).toBe("approved");
    expect(allDocs[0].googleDriveFileId).not.toBeNull();
  });

  it("a text-only reopen intent (no document held) just reopens the conversation, ready for what comes next", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedCompletedRequest();

    await createRequestReopenConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: null });
    const resolved = await resolveConfirmationFromReply(conversationId, "כן");
    await applyRequestReopenDecision(resolved!, reprocessHeldReopenDocument);

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("active");
    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(0); // nothing was ever held — nothing to process
  });
});
