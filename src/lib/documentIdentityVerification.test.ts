import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

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
const sendTemplateMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
  };
});

const {
  nameMatchScore,
  detectIdentityAnomaly,
  buildIdentityReferencePool,
  createOrMergeIdentityAnomalyConfirmation,
  applyIdentityAnomalyDecision,
} = await import("./documentIdentityVerification");
const { sendConfirmationRemindersAndEscalate } = await import("./documentIntakeReview");

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
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  sendTemplateMessage.mockReset();
});

// ---------------------------------------------------------------------------
// nameMatchScore — pure, no DB. Full/partial spelling, reversed word order,
// small OCR/spelling slips must all still score as "the same person"; a
// genuinely different name must not.
// ---------------------------------------------------------------------------

describe("nameMatchScore", () => {
  it("scores an exact match at 1", () => {
    expect(nameMatchScore("נועם שלום", "נועם שלום")).toBe(1);
  });

  it("is tolerant of reversed first/last name order", () => {
    expect(nameMatchScore("שלום נועם", "נועם שלום")).toBeGreaterThanOrEqual(0.6);
  });

  it("is tolerant of a small OCR/spelling slip (one-letter difference in a longer name)", () => {
    expect(nameMatchScore("נועם שלום", "נועם שלם")).toBeGreaterThanOrEqual(0.6);
  });

  it("scores a genuinely different name low", () => {
    expect(nameMatchScore("נועם שלום", "ישראל ישראלי")).toBeLessThan(0.35);
  });

  it("returns 0 when either name has no usable tokens", () => {
    expect(nameMatchScore("", "נועם שלום")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// detectIdentityAnomaly — pure, no DB.
// ---------------------------------------------------------------------------

describe("detectIdentityAnomaly", () => {
  const highConfidence = 0.9;

  it("no anomaly when the extracted name matches the client", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: "נועם שלום", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).toBeNull();
  });

  it("a minor spelling difference does not create a false positive", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: "נועם שלם", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).toBeNull();
  });

  it("confident name mismatch against the client — names the conflicting person", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: "ישראל ישראלי", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).toEqual({
      kind: "name_mismatch",
      confident: true,
      conflictingName: "ישראל ישראלי",
      maskedIdNumber: null,
    });
  });

  it("ID number mismatch against a sibling document — exact compare, masked to last 4", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: null, extractedIdNumber: "111111118", extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [{ idNumber: "222222226", personName: "נועם שלום" }], siblingCompanyNames: [] }
    );
    expect(result).toEqual({
      kind: "id_mismatch",
      confident: true,
      conflictingName: "נועם שלום",
      maskedIdNumber: "***2226",
    });
  });

  it("matching ID number against every sibling — no anomaly", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: null, extractedIdNumber: "111111118", extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [{ idNumber: "111111118", personName: "נועם שלום" }], siblingCompanyNames: [] }
    );
    expect(result).toBeNull();
  });

  it("below the extraction-confidence floor — never asserts an anomaly at all", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: "ישראל ישראלי", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: 0.2 },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).toBeNull();
  });

  it("ambiguous (mid-confidence) name score — flags it but without naming a specific person", () => {
    // A name that shares one token with the client but not the other lands
    // in the ambiguous band (0.35 <= score < 0.6), not a confident mismatch.
    const result = detectIdentityAnomaly(
      { extractedPersonName: "נועם כהן", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "נועם שלום", siblingPersonNames: [], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).not.toBeNull();
    expect(result!.confident).toBe(false);
    expect(result!.conflictingName).toBeNull();
  });

  it("matches against a sibling document's name even when it differs from the client record (e.g. a company client)", () => {
    const result = detectIdentityAnomaly(
      { extractedPersonName: "נועם שלום", extractedIdNumber: null, extractedCompanyName: null, identityExtractionConfidence: highConfidence },
      { clientName: "חברת ABC בע\"מ", siblingPersonNames: ["נועם שלום"], siblingIdNumbers: [], siblingCompanyNames: [] }
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: reference pool, creation/merge, resolution, reminders.
// ---------------------------------------------------------------------------

async function seedRequest(options?: { businessHoursAlwaysOpen?: boolean; whatsappPhoneNumberId?: string }) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleDriveFolderId: "root-1",
      documentCollectionEnabled: true,
      ...(options?.businessHoursAlwaysOpen
        ? { businessHoursStart: "00:00", businessHoursEnd: "23:59", businessDays: "0,1,2,3,4,5,6" }
        : {}),
      ...(options?.whatsappPhoneNumberId ? { whatsappPhoneNumberId: options.whatsappPhoneNumberId } : {}),
    })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "נועם שלום", phone: "+972500000000" })
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
  return { orgId: org.id, clientId: client.id, requestId: request.id, conversationId: conversation.id, clientName: client.name };
}

async function seedDocument(requestId: string, orgId: string, overrides?: Partial<typeof schema.documents.$inferInsert>) {
  const [doc] = await db
    .insert(schema.documents)
    .values({
      organizationId: orgId,
      collectionRequestId: requestId,
      fileName: "image_wamid.abc.jpg",
      status: "identity_anomaly_pending_confirmation",
      pendingFileContent: Buffer.from("fake-bytes"),
      pendingFileMimeType: "image/jpeg",
      ...overrides,
    })
    .returning();
  return doc;
}

describe("buildIdentityReferencePool", () => {
  it("builds the reference pool from sibling documents already established on the request, excluding pending/rejected anomalies", async () => {
    const { orgId, requestId, clientName } = await seedRequest();
    await seedDocument(requestId, orgId, { status: "approved", extractedPersonName: "נועם שלום", extractedIdNumber: "111111118" });
    await seedDocument(requestId, orgId, { status: "identity_anomaly_rejected", extractedPersonName: "מישהו אחר" });

    const pool = await buildIdentityReferencePool(requestId, null, clientName);
    expect(pool.siblingPersonNames).toEqual(["נועם שלום"]);
    expect(pool.siblingIdNumbers).toEqual([{ idNumber: "111111118", personName: "נועם שלום" }]);
  });
});

describe("createOrMergeIdentityAnomalyConfirmation — grouping", () => {
  it("groups several documents sharing the same anomaly into one pending confirmation instead of asking a separate question per file", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const doc1 = await seedDocument(requestId, orgId);
    const doc2 = await seedDocument(requestId, orgId);
    const doc3 = await seedDocument(requestId, orgId);
    const anomaly = { kind: "name_mismatch" as const, confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null };

    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc1.id, anomaly, documentType: "חשבונית" });
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc2.id, anomaly, documentType: "חשבונית" });
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc3.id, anomaly, documentType: "חשבונית" });

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as { documentIds: string[] };
    expect(payload.documentIds).toEqual([doc1.id, doc2.id, doc3.id]);
    expect(rows[0].question).toContain("3 מסמכים");

    // Only one question actually sent over WhatsApp — not one per document.
    const messages = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
  });

  it("handles a genuinely different anomaly as a separate question, not merged into an unrelated one", async () => {
    const { orgId, clientId, requestId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const doc1 = await seedDocument(requestId, orgId);
    const doc2 = await seedDocument(requestId, orgId);
    const anomalyA = { kind: "name_mismatch" as const, confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null };
    const anomalyB = { kind: "id_mismatch" as const, confident: true, conflictingName: null, maskedIdNumber: "***9999" };

    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc1.id, anomaly: anomalyA, documentType: null });
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc2.id, anomaly: anomalyB, documentType: null });

    const rows = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(rows).toHaveLength(2);
    expect(sendTextMessage).toHaveBeenCalledTimes(2);
  });
});

describe("applyIdentityAnomalyDecision", () => {
  it("client confirms it was sent on purpose — uploads to the client's folder, never marked as fulfilling a requirement", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const doc = await seedDocument(requestId, orgId);
    const anomaly = { kind: "name_mismatch" as const, confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null };
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc.id, anomaly, documentType: "חשבונית מס" });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyIdentityAnomalyDecision({ ...confirmation, status: "confirmed", conversationId });

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("identity_anomaly_confirmed");
    expect(after.requirementId).toBeNull();
    expect(after.googleDriveFileId).not.toBeNull();
    expect(fakeFiles).toHaveLength(1);
  });

  it("client says it was sent by mistake — never uploaded, pending bytes cleared, marked rejected", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest({ whatsappPhoneNumberId: "phone-1" });
    const doc = await seedDocument(requestId, orgId);
    const anomaly = { kind: "name_mismatch" as const, confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null };
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc.id, anomaly, documentType: "חשבונית מס" });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));

    await applyIdentityAnomalyDecision({ ...confirmation, status: "declined", conversationId });

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("identity_anomaly_rejected");
    expect(after.pendingFileContent).toBeNull();
    expect(fakeFiles).toHaveLength(0);
  });
});

describe("identity_anomaly reminders/escalation reuse the generic pending-confirmation cron pass", () => {
  it("client doesn't answer after the reminder budget is exhausted — escalates to needs_review, never approved or silently dropped", async () => {
    const { orgId, clientId, requestId } = await seedRequest({ businessHoursAlwaysOpen: true, whatsappPhoneNumberId: "phone-1" });
    const doc = await seedDocument(requestId, orgId);
    const anomaly = { kind: "name_mismatch" as const, confident: true, conflictingName: "ישראל ישראלי", maskedIdNumber: null };
    await createOrMergeIdentityAnomalyConfirmation({ organizationId: orgId, clientId, collectionRequestId: requestId, documentId: doc.id, anomaly, documentType: "חשבונית מס" });
    const [confirmation] = await db.select().from(schema.pendingConfirmations).where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    await db
      .update(schema.pendingConfirmations)
      .set({ remindersSent: 2, nextReminderAt: new Date(Date.now() - 1000) })
      .where(eq(schema.pendingConfirmations.id, confirmation.id));

    const result = await sendConfirmationRemindersAndEscalate(orgId);
    expect(result.escalated).toBe(1);

    const [after] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(after.status).toBe("needs_review");
  });
});
