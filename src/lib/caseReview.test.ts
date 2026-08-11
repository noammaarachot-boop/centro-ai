import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// "Centro checks the case, not the document" — a document classified as
// an exception during collection is never asked about immediately;
// caseReview.ts is what turns deferred exceptions into a real question,
// once, and what actually completes the request once nothing is left
// pending.

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
    moveDriveFile: vi.fn(async () => {}),
    trashDriveFolder: vi.fn(async () => {}),
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

const { isFinishedSignal, runCaseReview, attemptFinishCollectionRequest } = await import("./caseReview");
const { createOrMergeIdentityAnomalyConfirmation } = await import("./documentIdentityVerification");

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
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  sendInteractiveButtonsMessage.mockReset();
  sendInteractiveButtonsMessage.mockResolvedValue({ messageId: "wamid.out" });
});

describe("isFinishedSignal", () => {
  it("recognizes clear Hebrew and English 'I'm done' phrases", () => {
    for (const text of ["סיימתי", "סיימתי לשלוח", "זה הכל", "זהו", "העליתי הכל", "שלחתי הכל", "גמרתי", "finished", "done"]) {
      expect(isFinishedSignal(text), `"${text}"`).toBe(true);
    }
  });

  it("never guesses at an unrelated or negated message", () => {
    for (const text of ["", "עוד לא סיימתי", "מתי אתם פותחים?", "שלום", "יש לי עוד שאלה"]) {
      expect(isFinishedSignal(text), `"${text}"`).toBe(false);
    }
  });
});

async function seedRequest(requirementNames: string[]) {
  const [org] = await db
    .insert(schema.organizations)
    // Suffixed with a fresh uuid — seedRequest is called once per it()
    // block on one shared PGlite instance for the whole file, so a fixed
    // literal would collide with organizations_whatsapp_phone_number_id_idx
    // (Phase 1.6's unique constraint).
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח בדיקה", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
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
  return {
    orgId: org.id,
    clientId: client.id,
    requestId: request.id,
    conversationId: conversation.id,
    requirements,
  };
}

describe("runCaseReview", () => {
  it("is a no-op when nothing was ever deferred", async () => {
    const { orgId, clientId, requestId } = await seedRequest([]);
    const result = await runCaseReview(orgId, clientId, requestId);
    expect(result).toEqual({ hasPendingReview: false, groupCount: 0 });
    expect(sendTextMessage).not.toHaveBeenCalled();
  });

  it("groups every deferred document and sends exactly one message, then clears the deferred markers", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest([]);
    const [doc] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "id.jpg",
        status: "identity_anomaly_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
        deferredReviewKind: "identity_anomaly",
        deferredReviewPayload: {
          anomaly: { kind: "name_mismatch", confident: true, conflictingName: "אורית לוי", maskedIdNumber: null },
          documentType: "תעודת זהות",
        },
      })
      .returning();

    const result = await runCaseReview(orgId, clientId, requestId);
    expect(result.hasPendingReview).toBe(true);
    expect(result.groupCount).toBe(1);
    // A single question is sent as real WhatsApp Interactive Reply
    // Buttons, not plain numbered text.
    expect(sendInteractiveButtonsMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).not.toHaveBeenCalled();

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.deferredReviewKind).toBeNull();
    expect(after.deferredReviewPayload).toBeNull();

    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmation.status).toBe("pending");
    expect(confirmation.notifiedAt).not.toBeNull();

    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(messages).toHaveLength(1);
  });
});

describe("attemptFinishCollectionRequest", () => {
  it("completes the request and sends a short thank-you when everything is already approved", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        requirementId: requirements[0].id,
        fileName: "id.jpg",
        status: "approved",
      });

    const outcome = await attemptFinishCollectionRequest({
      organizationId: orgId,
      collectionRequestId: requestId,
      conversationId,
      clientId,
      actorType: "client",
    });

    expect(outcome).toBe("completed");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("קיבלתי את כל המסמכים שנדרשו:");
  });

  it("tells the client exactly what's still missing, in one short message, instead of silently failing", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות", "אישור ניהול חשבון"]);

    const outcome = await attemptFinishCollectionRequest({
      organizationId: orgId,
      collectionRequestId: requestId,
      conversationId,
      clientId,
      actorType: "client",
    });

    expect(outcome).toBe("missing_requirements");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("תעודת זהות");
    expect(body).toContain("אישור ניהול חשבון");
  });

  it("reports quantity-aware progress for a partially-satisfied multi-unit requirement (e.g. 1 of 3 payslips)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    await db
      .update(schema.collectionRequestRequirements)
      .set({ requiredCount: 3 })
      .where(eq(schema.collectionRequestRequirements.id, requirements[0].id));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirements[0].id,
      fileName: "payslip-jan.jpg",
      status: "approved",
      extractedPeriodLabel: "01/2026",
    });

    const outcome = await attemptFinishCollectionRequest({
      organizationId: orgId,
      collectionRequestId: requestId,
      conversationId,
      clientId,
      actorType: "client",
    });

    expect(outcome).toBe("missing_requirements");
    const body = sendTextMessage.mock.calls[0][2] as string;
    expect(body).toContain("תלוש שכר");
    expect(body).toContain("1 מתוך 3");
  });

  it("reviews the whole case first — a deferred exception is asked about instead of the request completing or failing silently", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות"]);
    const [doc] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "id.jpg",
        status: "identity_anomaly_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
        deferredReviewKind: "identity_anomaly",
        deferredReviewPayload: {
          anomaly: { kind: "name_mismatch", confident: true, conflictingName: "אורית לוי", maskedIdNumber: null },
          documentType: "תעודת זהות",
        },
      })
      .returning();

    const outcome = await attemptFinishCollectionRequest({
      organizationId: orgId,
      collectionRequestId: requestId,
      conversationId,
      clientId,
      actorType: "client",
    });

    expect(outcome).toBe("review_pending");
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
    // Only the grouped review question (a solo group, sent via Interactive
    // Reply Buttons) — no separate "completed" or "missing requirements"
    // message was also sent.
    expect(sendInteractiveButtonsMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage).not.toHaveBeenCalled();
    const body = sendInteractiveButtonsMessage.mock.calls[0][2] as string;
    expect(body).toContain("אורית לוי");

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.deferredReviewKind).toBeNull();
  });

  it("createOrMergeIdentityAnomalyConfirmation itself never sends immediately — only runCaseReview's own flush does (sanity check on the deferral boundary)", async () => {
    const { orgId, clientId, requestId } = await seedRequest([]);
    const [doc] = await db
      .insert(schema.documents)
      .values({ organizationId: orgId, collectionRequestId: requestId, fileName: "id.jpg", status: "identity_anomaly_pending_confirmation" })
      .returning();

    await createOrMergeIdentityAnomalyConfirmation({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      documentId: doc.id,
      anomaly: { kind: "name_mismatch", confident: true, conflictingName: "אורית לוי", maskedIdNumber: null },
      documentType: "תעודת זהות",
      matchedRequirementId: null,
      extractedPersonName: null,
      extractedCompanyName: null,
      clientName: "",
    });

    expect(sendTextMessage).not.toHaveBeenCalled();
  });
});

// applyFollowUpPromiseIfAny moved into reminderDeferral.ts's applyDeferralIfAny
// (the "not_dated" branch) as part of the deferral-count/escalation policy —
// see reminderDeferral.integration.test.ts for its coverage now.
