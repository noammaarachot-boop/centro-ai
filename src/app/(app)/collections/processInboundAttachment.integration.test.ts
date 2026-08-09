import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
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
  content?: Buffer;
  mimeType?: string;
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
    uploadDriveFile: vi.fn(
      async (_token: string, options: { name: string; parentId: string; mimeType?: string; content?: Buffer }) => {
        const id = `file-${nextId++}`;
        fakeFiles.push({ id, name: options.name, parentId: options.parentId, content: options.content, mimeType: options.mimeType });
        return { id, name: options.name, webViewLink: `https://drive.example/${id}` };
      }
    ),
    renameDriveFile: vi.fn(async (_token: string, fileId: string, newName: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) file.name = newName;
    }),
    downloadDriveFile: vi.fn(async (_token: string, fileId: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (!file) throw new Error(`fake drive file ${fileId} not found`);
      return { bytes: file.content ?? Buffer.from(""), mimeType: file.mimeType ?? "application/octet-stream" };
    }),
    updateDriveFileContent: vi.fn(async (_token: string, fileId: string, content: Buffer, mimeType: string) => {
      const file = fakeFiles.find((f) => f.id === fileId);
      if (file) {
        file.content = content;
        file.mimeType = mimeType;
      }
    }),
  };
});

const classifyDocumentViaVisionAI = vi.fn();
vi.mock("@/lib/ai/documentVisionClassifier", () => ({
  classifyDocumentViaVisionAI: (...args: unknown[]) => classifyDocumentViaVisionAI(...args),
  isVisionClassifiableMimeType: () => true,
}));

const classifyDocumentRelationIntent = vi.fn();
vi.mock("@/lib/ai/conversationReplyIntent", () => ({
  classifyDocumentRelationIntent: (...args: unknown[]) => classifyDocumentRelationIntent(...args),
}));

// Real single-PDF merging (src/lib/documentMerge.ts) actually calls
// pdf-lib's embedPng/embedJpg on these bytes — Buffer.from("page1")-style
// placeholders used elsewhere in this file aren't valid image data and
// would throw there. This is the smallest possible valid 1x1 PNG.
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const { processInboundAttachment } = await import("./conversationActions");
const { CASE_REVIEW_SILENCE_WINDOW_MS } = await import("@/lib/caseReview");
const { checkCompletionGate } = await import("@/lib/collectionRequestStateMachine");

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
  classifyDocumentRelationIntent.mockReset();
  classifyDocumentRelationIntent.mockResolvedValue("none");
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
      identified: true,
      documentType: "רישיון נהיגה",
      identificationConfidence: 0.98,
      matchedRequirementId: licenseReq.id,
      matchConfidence: 0.98,
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
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.98,
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
    // the AI identifies with real confidence, but that doesn't match
    // either of the two still-open requirements.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית מס קבלה",
      identificationConfidence: 0.97,
      matchedRequirementId: null,
      matchConfidence: 0,
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

    // Message 4 ("~6 minutes later"): another identified-but-unneeded document.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חשבונית שירות טלפוני",
      identificationConfidence: 0.95,
      matchedRequirementId: null,
      matchConfidence: 0,
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
    const unsolicited = allDocs.filter((d) => d.status === "unsolicited_pending_confirmation");
    // Ch.6: identified-but-unneeded documents are never needs_review —
    // they wait on the client's own yes/no answer instead.
    const needsReview = allDocs.filter((d) => d.status === "needs_review");
    expect(approved).toHaveLength(2);
    expect(unsolicited).toHaveLength(2);
    expect(needsReview).toHaveLength(0);

    // Both approved documents landed in the exact same Drive folder — no
    // per-call folder drift, no duplicate folder for the later arrivals.
    const approvedFileIds = approved.map((d) => d.googleDriveFileId);
    const parents = new Set(fakeFiles.filter((f) => approvedFileIds.includes(f.id)).map((f) => f.parentId));
    expect(parents.size).toBe(1);

    // Neither unsolicited document was uploaded to Drive yet — waiting on
    // the client, not auto-filed and not dropped.
    for (const doc of unsolicited) {
      expect(doc.requirementId).toBeNull();
      expect(doc.googleDriveFileId).toBeNull();
    }

    // Asked about immediately, not deferred to whole-case-review time —
    // each unsolicited document already has its own pendingConfirmation
    // right after intake (two different document types, so two separate
    // groups), just not yet flushed/sent (still inside its short
    // notification-grouping window).
    expect(unsolicited.every((d) => d.deferredReviewKind === null)).toBe(true);
    const openConfirmations = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const unsolicitedConfirmations = openConfirmations.filter((c) => c.kind === "unsolicited_document");
    expect(unsolicitedConfirmations).toHaveLength(2);
    expect(unsolicitedConfirmations.every((c) => c.status === "pending" && c.notifiedAt === null)).toBe(true);

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
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.98,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.98,
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

  // Decision-engine "Level 1" principle: the system resolves a duplicate
  // entirely on its own — the client never even needs to know there was a
  // dilemma. No WhatsApp message, still fully audited.
  it("a duplicate document is resolved silently — no WhatsApp message, but still audited", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    // The filename itself ("bank-statement-jan.pdf") doesn't resemble
    // "תעודת זהות" at all — real content confirmation is what actually
    // establishes this as the approved document the second (duplicate)
    // call gets compared against; this test is about isFuzzyDuplicate
    // detection, not about how the first one got approved.
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "bank-statement-jan.pdf", null, Buffer.from("x"), "application/pdf", "wamid.dup.1");
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "bank-statement-jan-copy.pdf", null, Buffer.from("y"), "application/pdf", "wamid.dup.2");

    const outboundMessages = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outboundMessages).toHaveLength(0);

    const auditEvents = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.collectionRequestId, requestId), eq(schema.auditLogs.eventType, "document.duplicate_detected")));
    expect(auditEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Quantity-aware requirement engine (src/lib/documentQuantity.ts) — a
// requirement can ask for more than one unit (collectionRequestRequirements.requiredCount),
// e.g. "3 תלושי שכר". Mandatory scenarios #11/#12 from the product spec.
// ---------------------------------------------------------------------------
describe("processInboundAttachment — quantity-aware requirements (requiredCount > 1)", () => {
  it("3 payslips for 3 different months satisfy a requiredCount of 3", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db
      .update(schema.collectionRequestRequirements)
      .set({ requiredCount: 3 })
      .where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    for (const [wamid, period] of [
      ["wamid.p1", "01/2026"],
      ["wamid.p2", "02/2026"],
      ["wamid.p3", "03/2026"],
    ] as const) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: payslipReq.id,
        matchConfidence: 0.95,
        extractedPersonName: null,
        extractedIdNumber: null,
        extractedCompanyName: null,
        identityExtractionConfidence: 0,
        documentPeriodLabel: period,
        periodExtractionConfidence: 0.9,
      });
      await processInboundAttachment(
        orgId,
        requestId,
        conversationId,
        clientId,
        `image_${wamid}.jpg`,
        null,
        Buffer.from(period),
        "image/jpeg",
        wamid
      );
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.status === "approved")).toBe(true);
    expect(new Set(docs.map((d) => d.extractedPeriodLabel))).toEqual(new Set(["01/2026", "02/2026", "03/2026"]));

    expect(await checkCompletionGate(requestId)).toBeNull();
  });

  it("3 payslips for the SAME month do not satisfy a requiredCount of 3 — every document is still approved silently, but the requirement stays open", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db
      .update(schema.collectionRequestRequirements)
      .set({ requiredCount: 3 })
      .where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    for (const wamid of ["wamid.s1", "wamid.s2", "wamid.s3"]) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: payslipReq.id,
        matchConfidence: 0.95,
        extractedPersonName: null,
        extractedIdNumber: null,
        extractedCompanyName: null,
        identityExtractionConfidence: 0,
        documentPeriodLabel: "01/2026", // same month every time
        periodExtractionConfidence: 0.9,
      });
      await processInboundAttachment(
        orgId,
        requestId,
        conversationId,
        clientId,
        `image_${wamid}.jpg`,
        null,
        Buffer.from(wamid),
        "image/jpeg",
        wamid
      );
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(3);
    // Level 1 principle: Centro never refuses or interrupts about the
    // same-month repeats — all three are still auto-approved and uploaded.
    expect(docs.every((d) => d.status === "approved")).toBe(true);
    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(0);

    // But the *quantity* gate stays honest: only 1 distinct month is
    // actually represented, so the requirement is still short 2 — the
    // request cannot complete yet.
    expect(await checkCompletionGate(requestId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Multi-page document merging — mandatory scenarios #7/#8: a multi-page
// document, and several images sent together.
// ---------------------------------------------------------------------------
describe("processInboundAttachment — multi-page document merging", () => {
  it("a second confidently-matched page for a requiredCount=1 requirement, arriving soon after, merges as a continuation page instead of a separate unit", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.page1.jpg", null, Buffer.from("page1"), "image/jpeg", "wamid.page1");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.94,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.94,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.page2.jpg", null, Buffer.from("page2"), "image/jpeg", "wamid.page2");

    const docs = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.collectionRequestId, requestId))
      .orderBy(schema.documents.receivedAt);
    expect(docs).toHaveLength(2);
    expect(docs[0].status).toBe("approved");
    expect(docs[0].continuationOfDocumentId).toBeNull();
    expect(docs[1].status).toBe("approved");
    expect(docs[1].continuationOfDocumentId).toBe(docs[0].id);

    // Both pages were still uploaded to Drive — never lost.
    expect(docs.every((d) => d.googleDriveFileId !== null)).toBe(true);

    // The requirement reads as satisfied by exactly one unit — the
    // continuation page never inflates it to "2 documents received" for a
    // requiredCount=1 requirement, and no "was this intentional?" question
    // was ever raised about the second page.
    expect(await checkCompletionGate(requestId)).toBeNull();
    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(0);
  });

  it("never merges a second match for a requiredCount > 1 requirement — each is a genuinely separate unit", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db.update(schema.collectionRequestRequirements).set({ requiredCount: 3 }).where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    for (const wamid of ["wamid.q1", "wamid.q2"]) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: payslipReq.id,
        matchConfidence: 0.95,
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, `image_${wamid}.jpg`, null, Buffer.from(wamid), "image/jpeg", wamid);
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.continuationOfDocumentId === null)).toBe(true);
  });

  it("does not merge a second match arriving well outside the continuation window — becomes its own independent unit", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.old.jpg", null, Buffer.from("page1"), "image/jpeg", "wamid.old");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000)); // 10 minutes later — well past the 120s window
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.95,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.95,
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.new.jpg", null, Buffer.from("page2"), "image/jpeg", "wamid.new");
    } finally {
      vi.useRealTimers();
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.continuationOfDocumentId === null)).toBe(true);
  });

  // Multi-signal multi-page detection (src/lib/documentContinuation.ts): a
  // matching contract/case number extracted from both pages is enough to
  // still trust the merge even well past the old fixed 120-second window,
  // as long as it's inside the hard 10-minute cutoff.
  it("merges a later page (past the old 2-minute window) when both pages share the same extracted reference number", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
      documentReferenceNumber: "AGR-4471",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.ref1.jpg", null, Buffer.from("page1"), "image/jpeg", "wamid.ref1");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 7 * 60 * 1000)); // 7 minutes later — past the old 120s window
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.94,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.94,
        documentReferenceNumber: "AGR-4471",
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.ref2.jpg", null, Buffer.from("page2"), "image/jpeg", "wamid.ref2");
    } finally {
      vi.useRealTimers();
    }

    const docs = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.collectionRequestId, requestId))
      .orderBy(schema.documents.receivedAt);
    expect(docs).toHaveLength(2);
    expect(docs[1].continuationOfDocumentId).toBe(docs[0].id);
  });

  // Same idea, driven by sequential printed page numbers ("עמוד 2 מתוך 2"
  // following "עמוד 1 מתוך 2") instead of a reference number.
  it("merges a later page when its printed page number sequentially follows the prior page's", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
      pageNumberCurrent: 1,
      pageNumberTotal: 2,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.pg1.jpg", null, Buffer.from("page1"), "image/jpeg", "wamid.pg1");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 7 * 60 * 1000)); // 7 minutes later — past the old 120s window
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.94,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.94,
        pageNumberCurrent: 2,
        pageNumberTotal: 2,
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.pg2.jpg", null, Buffer.from("page2"), "image/jpeg", "wamid.pg2");
    } finally {
      vi.useRealTimers();
    }

    const docs = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.collectionRequestId, requestId))
      .orderBy(schema.documents.receivedAt);
    expect(docs).toHaveLength(2);
    expect(docs[1].continuationOfDocumentId).toBe(docs[0].id);
  });

  // Two genuinely different documents of the same type, sent a few minutes
  // apart with mismatched reference numbers and no other corroborating
  // signal, must never be wrongly merged as continuation pages of one
  // another — each stays its own independent unit.
  it("never merges two distinct documents that happen to share a type but carry mismatched reference numbers and no other corroborating signal", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
      documentReferenceNumber: "AGR-1000",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.distinctA.jpg", null, Buffer.from("docA"), "image/jpeg", "wamid.distinctA");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 7 * 60 * 1000)); // 7 minutes later — past the old 120s window
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.95,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.95,
        documentReferenceNumber: "AGR-2000",
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, "image_wamid.distinctB.jpg", null, Buffer.from("docB"), "image/jpeg", "wamid.distinctB");
    } finally {
      vi.useRealTimers();
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => d.continuationOfDocumentId === null)).toBe(true);
  });
});

// Real single-PDF merging end to end (mandatory scenario #12/#14): once
// multi-page detection confidently recognizes several images as one
// document, Centro must produce exactly one real merged PDF file in
// Drive — not just link several separate image files in the database.
describe("processInboundAttachment — real single-PDF merging", () => {
  it("5 images of the same document merge into exactly one real PDF file in Drive, never counted as 5 documents", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    for (let page = 1; page <= 5; page++) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.95,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.95,
        pageNumberCurrent: page,
        pageNumberTotal: 5,
      });
      await processInboundAttachment(
        orgId,
        requestId,
        conversationId,
        clientId,
        `image_wamid.mergepage${page}.jpg`,
        null,
        MINIMAL_PNG,
        "image/png",
        `wamid.mergepage${page}`
      );
    }

    const docs = await db
      .select()
      .from(schema.documents)
      .where(eq(schema.documents.collectionRequestId, requestId))
      .orderBy(schema.documents.receivedAt);
    expect(docs).toHaveLength(5);
    const head = docs[0];
    expect(head.continuationOfDocumentId).toBeNull();
    expect(docs.slice(1).every((d) => d.continuationOfDocumentId === head.id)).toBe(true);

    // Never counted as 5 separate documents for a requiredCount=1
    // requirement.
    expect(await checkCompletionGate(requestId)).toBeNull();

    // Exactly one merged PDF file was produced (created once, then updated
    // in place 4 times — never a new file per page).
    expect(head.mergedPdfDriveFileId).not.toBeNull();
    expect(head.mergedPdfVersion).toBe(4);
    const mergedFile = fakeFiles.find((f) => f.id === head.mergedPdfDriveFileId);
    expect(mergedFile).toBeDefined();
    expect(mergedFile!.mimeType).toBe("application/pdf");

    // Every raw source page still has its own individual Drive file too —
    // nothing was deleted.
    expect(fakeFiles.filter((f) => f.mimeType !== "application/pdf")).toHaveLength(5);
    // Exactly one merged PDF among all Drive files (not one per page).
    expect(fakeFiles.filter((f) => f.mimeType === "application/pdf")).toHaveLength(1);

    // The merged file is a real, valid PDF with all 5 pages, in order.
    const { PDFDocument } = await import("pdf-lib");
    const mergedPdf = await PDFDocument.load(mergedFile!.content!);
    expect(mergedPdf.getPageCount()).toBe(5);
  });

  it("a late-arriving page updates the same merged PDF file in place — never a duplicate file", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["חוזה שכירות"]);
    const leaseReq = requirements[0];

    for (let page = 1; page <= 2; page++) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "חוזה שכירות",
        identificationConfidence: 0.95,
        matchedRequirementId: leaseReq.id,
        matchConfidence: 0.95,
        pageNumberCurrent: page,
        pageNumberTotal: 3,
      });
      await processInboundAttachment(
        orgId,
        requestId,
        conversationId,
        clientId,
        `image_wamid.latepage${page}.jpg`,
        null,
        MINIMAL_PNG,
        "image/png",
        `wamid.latepage${page}`
      );
    }
    const docsAfterTwo = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    const head = docsAfterTwo.find((d) => d.continuationOfDocumentId === null)!;
    const mergedFileIdAfterTwo = head.mergedPdfDriveFileId;
    expect(mergedFileIdAfterTwo).not.toBeNull();

    // A third page, arriving later, clearly belonging to the same document
    // (matching total page count, sequential page number).
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "חוזה שכירות",
      identificationConfidence: 0.95,
      matchedRequirementId: leaseReq.id,
      matchConfidence: 0.95,
      pageNumberCurrent: 3,
      pageNumberTotal: 3,
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "image_wamid.latepage3.jpg",
      null,
      MINIMAL_PNG,
      "image/png",
      "wamid.latepage3"
    );

    const [updatedHead] = await db.select().from(schema.documents).where(eq(schema.documents.id, head.id));
    // Same Drive file id — updated in place, never a second merged file.
    expect(updatedHead.mergedPdfDriveFileId).toBe(mergedFileIdAfterTwo);
    expect(updatedHead.mergedPdfVersion).toBe(2);
    expect(fakeFiles.filter((f) => f.mimeType === "application/pdf")).toHaveLength(1);

    const { PDFDocument } = await import("pdf-lib");
    const mergedFile = fakeFiles.find((f) => f.id === updatedHead.mergedPdfDriveFileId);
    const mergedPdf = await PDFDocument.load(mergedFile!.content!);
    expect(mergedPdf.getPageCount()).toBe(3);
  });
});

// Mandatory scenario #10: an unreadable file (FR-11.3) is never silently
// filed or sent to needs_review — the client is asked for a clearer copy,
// and no document row is created at all (nothing to review yet).
describe("processInboundAttachment — unreadable file", () => {
  it("asks for a clearer copy and never creates a document row", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות"]);

    // Base filename shorter than 2 characters trips checkFileGate's
    // readable:false gate before any AI classification is even attempted.
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "a.pdf", null, Buffer.from("x"), "application/pdf", "wamid.unreadable");

    expect(classifyDocumentViaVisionAI).not.toHaveBeenCalled();
    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(0);

    const messages = await db.select().from(schema.messages).where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toContain("לא הצלחתי לקרוא את הקובץ");

    const auditEvents = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.collectionRequestId, requestId), eq(schema.auditLogs.eventType, "document.unreadable")));
    expect(auditEvents).toHaveLength(1);
  });
});

// Semantic requirement engine (src/lib/ai/requirementSemantics.ts) — end to
// end through the real intake pipeline, not just the pure
// computeRequirementSatisfaction function (already exhaustively covered in
// documentQuantity.test.ts). Mandatory scenarios #1-#3 from the spec.
describe("processInboundAttachment — semantic requirement engine end to end", () => {
  it("'3 payslips of June' + 3 payslips all for June -> satisfied (same period expected, not a red flag)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db
      .update(schema.collectionRequestRequirements)
      .set({
        requiredCount: 3,
        semanticSpec: {
          originalText: "3 תלושי שכר של חודש יוני",
          documentType: "תלוש שכר",
          requiredCount: 3,
          periodType: "explicit",
          explicitPeriods: ["06/2026"],
          relativePeriod: null,
          samePeriodAllowed: true,
          distinctPeriodsRequired: false,
          distinctPeopleRequired: false,
          expectedPersonOrCompany: null,
          validityRequirement: null,
          supportingDocumentRelationship: null,
          freeTextConstraints: null,
          interpretationConfidence: 0.9,
          clarifyingQuestion: null,
        },
      })
      .where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    for (const wamid of ["wamid.j1", "wamid.j2", "wamid.j3"]) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: payslipReq.id,
        matchConfidence: 0.95,
        extractedPersonName: null,
        extractedIdNumber: null,
        extractedCompanyName: null,
        identityExtractionConfidence: 0,
        documentPeriodLabel: "06/2026", // same June every time — expected here
        periodExtractionConfidence: 0.9,
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, `image_${wamid}.jpg`, null, Buffer.from(wamid), "image/jpeg", wamid);
    }

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(docs).toHaveLength(3);
    expect(docs.every((d) => d.status === "approved")).toBe(true);
    expect(await checkCompletionGate(requestId)).toBeNull();
  });

  it("'3 payslips of 3 last months' + 3 payslips all for the SAME month -> still open (distinct periods genuinely required)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db
      .update(schema.collectionRequestRequirements)
      .set({
        requiredCount: 3,
        semanticSpec: {
          originalText: "3 תלושי שכר של 3 החודשים האחרונים",
          documentType: "תלוש שכר",
          requiredCount: 3,
          periodType: "relative",
          explicitPeriods: null,
          relativePeriod: { kind: "last_n_months", n: 3 },
          samePeriodAllowed: false,
          distinctPeriodsRequired: true,
          distinctPeopleRequired: false,
          expectedPersonOrCompany: null,
          validityRequirement: null,
          supportingDocumentRelationship: null,
          freeTextConstraints: null,
          interpretationConfidence: 0.9,
          clarifyingQuestion: null,
        },
      })
      .where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    for (const wamid of ["wamid.r1", "wamid.r2", "wamid.r3"]) {
      classifyDocumentViaVisionAI.mockResolvedValueOnce({
        identified: true,
        documentType: "תלוש שכר",
        identificationConfidence: 0.95,
        matchedRequirementId: payslipReq.id,
        matchConfidence: 0.95,
        extractedPersonName: null,
        extractedIdNumber: null,
        extractedCompanyName: null,
        identityExtractionConfidence: 0,
        documentPeriodLabel: "06/2026", // same month every time
        periodExtractionConfidence: 0.9,
      });
      await processInboundAttachment(orgId, requestId, conversationId, clientId, `image_${wamid}.jpg`, null, Buffer.from(wamid), "image/jpeg", wamid);
    }

    expect(await checkCompletionGate(requestId)).not.toBeNull();
  });
});

// Document replace/supersede (src/lib/documentReplace.ts) — mandatory
// scenarios #7/#8: "this replaces the previous" vs "this is additional,
// not a replacement."
describe("processInboundAttachment — document replace/supersede via caption", () => {
  it("'זה מחליף את הקודם' supersedes the prior approved document — never deleted, renamed in Drive, excluded from active counts", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    const idReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id-v1.jpg", null, Buffer.from("v1"), "image/jpeg", "wamid.v1");

    const [original] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(original.status).toBe("approved");
    const originalDriveFileId = original.googleDriveFileId!;

    classifyDocumentRelationIntent.mockResolvedValueOnce("replace");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "id-v2.jpg",
      null,
      Buffer.from("v2"),
      "image/jpeg",
      "wamid.v2",
      "זה מחליף את הקודם"
    );

    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(2); // never deleted — both rows still exist
    const supersededDoc = allDocs.find((d) => d.id === original.id)!;
    const newDoc = allDocs.find((d) => d.id !== original.id)!;
    expect(supersededDoc.status).toBe("superseded");
    expect(supersededDoc.supersededByDocumentId).toBe(newDoc.id);
    expect(newDoc.status).toBe("approved");

    // Renamed in Drive, not deleted or moved out of the client's folder.
    const renamedFile = fakeFiles.find((f) => f.id === originalDriveFileId)!;
    expect(renamedFile.name).toContain("הוחלף");

    // Only the new document counts as satisfying the requirement now.
    expect(await checkCompletionGate(requestId)).toBeNull();

    const auditEvents = await db
      .select()
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.collectionRequestId, requestId), eq(schema.auditLogs.eventType, "document.superseded")));
    expect(auditEvents).toHaveLength(1);
  });

  it("'זה מסמך נוסף, לא מחליף' never supersedes anything — both documents stay active", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תלוש שכר"]);
    const payslipReq = requirements[0];
    await db.update(schema.collectionRequestRequirements).set({ requiredCount: 2 }).where(eq(schema.collectionRequestRequirements.id, payslipReq.id));

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תלוש שכר",
      identificationConfidence: 0.95,
      matchedRequirementId: payslipReq.id,
      matchConfidence: 0.95,
      documentPeriodLabel: "01/2026",
      periodExtractionConfidence: 0.9,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "payslip1.jpg", null, Buffer.from("p1"), "image/jpeg", "wamid.repl-add1");

    classifyDocumentRelationIntent.mockResolvedValueOnce("additional");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תלוש שכר",
      identificationConfidence: 0.95,
      matchedRequirementId: payslipReq.id,
      matchConfidence: 0.95,
      documentPeriodLabel: "02/2026",
      periodExtractionConfidence: 0.9,
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "payslip2.jpg",
      null,
      Buffer.from("p2"),
      "image/jpeg",
      "wamid.repl-add2",
      "זה מסמך נוסף, לא מחליף"
    );

    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs).toHaveLength(2);
    expect(allDocs.every((d) => d.status === "approved")).toBe(true);
    expect(allDocs.every((d) => d.supersededByDocumentId === null)).toBe(true);
  });

  it("a caption present but with no clear relation ('none') never supersedes — same as no caption at all", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    const idReq = requirements[0];

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id-v1.jpg", null, Buffer.from("v1"), "image/jpeg", "wamid.n1");

    classifyDocumentRelationIntent.mockResolvedValueOnce("none");
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(
      orgId,
      requestId,
      conversationId,
      clientId,
      "id-v2.jpg",
      null,
      Buffer.from("v2"),
      "image/jpeg",
      "wamid.n2",
      "הנה התלוש"
    );

    const allDocs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(allDocs.every((d) => d.supersededByDocumentId === null)).toBe(true);
  });
});

// Reminder infrastructure — "ברגע שכל הדרישות הושלמו... הבקשה נסגרת מיד":
// completion never depends on the client saying "finished" or on the
// reminder cycle noticing — it happens the instant the last requirement is
// actually satisfied.
describe("processInboundAttachment — immediate completion the instant nothing is left missing", () => {
  it("completes the request right away when the arriving document is the last thing missing — no 'finished' phrase needed", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    const idReq = requirements[0];
    // completeCollectionRequest only allows draft->processing->completed
    // via "active" first — seedRequest's own default status ("draft") is
    // irrelevant to what this test actually verifies.
    await db.update(schema.collectionRequests).set({ status: "active" }).where(eq(schema.collectionRequests.id, requestId));

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.instant1");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");

    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("קיבלתי הכל");
  });

  it("never sends a 'still missing' message after an ordinary document that doesn't complete the request", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "דף חשבון בנק"]);
    const idReq = requirements.find((r) => r.name === "תעודת זהות")!;

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.instant2");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(0); // completely silent — never interrupts mid-collection
  });
});

describe("processInboundAttachment — a filename that merely echoes a requirement's name is never enough, on its own, to approve it (real production incident)", () => {
  // Reproduces exactly what happened: a WhatsApp *document* attachment
  // (which, unlike a photo, keeps the sender's own filename — see
  // resolveAttachment in the webhook route) named
  // "08_תעודת_זהות_אדם_אחר.pdf" scored a perfect filename-token match
  // against the "תעודת זהות" requirement and was auto-approved WITHOUT
  // the vision model ever running — extractedPersonName came back null
  // because classifyDocumentViaAI was never even called, not because it
  // looked and found nothing. Fixed in documentClassifier.ts: a filename-
  // only match may only skip real content classification when there is no
  // real file content to check in the first place.
  const ECHO_FILENAME = "08_תעודת_זהות_אדם_אחר.pdf"; // deliberately echoes "תעודת זהות"

  it("real content confirms the SAME person → still approves normally (the fix must not break the legitimate case)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
      extractedPersonName: "רז שלום",
      extractedIdNumber: "111111118",
      identityExtractionConfidence: 0.9,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, ECHO_FILENAME, null, Buffer.from("real-bytes"), "application/pdf", "wamid.echo-ok");

    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1); // the actual fix: this must run
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("approved");
    expect(doc.requirementId).toBe(requirements[0].id);
  });

  it("real content belongs to a DIFFERENT person → never auto-approves; routes to identity_anomaly, requirement stays missing", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
      extractedPersonName: "דוד כהן", // not the client (רז שלום)
      extractedIdNumber: "000000099",
      identityExtractionConfidence: 0.9,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, ECHO_FILENAME, null, Buffer.from("real-bytes"), "application/pdf", "wamid.echo-anomaly");

    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("identity_anomaly_pending_confirmation");
    expect(doc.requirementId).toBeNull();
    expect(doc.extractedPersonName).toBe("דוד כהן");
    // The requirement genuinely never received a matching document.
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
  });

  it("real content is genuinely unreadable → never auto-approves; asks for a resend instead of guessing from the filename", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.1,
      matchedRequirementId: null,
      matchConfidence: 0,
      readabilityIssue: "damaged",
      readabilityIssueDetail: "לא ניתן לקרוא את תוכן המסמך",
      clientMessageIfProblematic: "לא הצלחתי לזהות בבירור את תעודת הזהות ששלחת. נא לשלוח צילום חדש, ברור ומלא של תעודת הזהות.",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, ECHO_FILENAME, null, Buffer.from("garbled-bytes"), "application/pdf", "wamid.echo-unreadable");

    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("clarification_requested");
    expect(doc.requirementId).toBeNull();

    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe("לא הצלחתי לזהות בבירור את תעודת הזהות ששלחת. נא לשלוח צילום חדש, ברור ומלא של תעודת הזהות.");

    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).not.toBe("completed");
  });

  it("AI runs and confirms the content is genuinely legible, just can't name it, with only ONE requirement outstanding → still resolved there (the legitimate WhatsApp-photo case must keep working)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.2,
      matchedRequirementId: null,
      matchConfidence: 0,
      // No readabilityIssue — the image itself is fine, the AI just
      // couldn't confidently name it. This is exactly the case
      // resolveRequirementAssignment's sole-outstanding fallback exists
      // for (e.g. a WhatsApp photo with a meaningless generated
      // filename) — must still resolve it here, now gated on the AI
      // having actually confirmed legibility rather than a blind guess.
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, ECHO_FILENAME, null, Buffer.from("real-bytes"), "application/pdf", "wamid.echo-unidentified");

    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("approved");
    expect(doc.requirementId).toBe(requirements[0].id);
  });

  it("AI runs but flags a readability problem, with only ONE requirement outstanding → never guesses by elimination, asks for a resend instead", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.1,
      matchedRequirementId: null,
      matchConfidence: 0,
      readabilityIssue: "too_dark_or_low_quality",
      readabilityIssueDetail: "התמונה כהה מדי",
      clientMessageIfProblematic: "לא הצלחתי לזהות בבירור את המסמך ששלחת — התמונה כהה מדי. נא לשלוח צילום חדש וברור.",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, ECHO_FILENAME, null, Buffer.from("real-bytes"), "application/pdf", "wamid.echo-unidentified-dark");

    expect(classifyDocumentViaVisionAI).toHaveBeenCalledTimes(1);
    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("clarification_requested"); // needs_resend, not a guessed approval
    expect(doc.requirementId).toBeNull();
  });
});

describe("processInboundAttachment — needs_resend: an unusable document gets an immediate, specific reply, never a silent hold", () => {
  it("a blurry document never auto-approves, replies immediately with the AI's own crafted message, and is never deferred", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.9,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.88,
      readabilityIssue: "blurry",
      readabilityIssueDetail: "האותיות לא קריאות",
      clientMessageIfProblematic: "קיבלתי את תעודת הזהות, אבל התמונה מטושטשת מדי. אפשר לצלם שוב, בבירור?",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.blur1");

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("clarification_requested");
    expect(doc.requirementId).toBeNull();
    expect(doc.deferredReviewKind).toBeNull(); // never deferred — this is the whole point

    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toBe("קיבלתי את תעודת הזהות, אבל התמונה מטושטשת מדי. אפשר לצלם שוב, בבירור?");

    const openConfirmation = (
      await db
        .select()
        .from(schema.pendingConfirmations)
        .where(and(eq(schema.pendingConfirmations.collectionRequestId, requestId), eq(schema.pendingConfirmations.status, "pending")))
    )[0];
    expect(openConfirmation?.kind).toBe("document_clarification");
  });

  it("a genuinely unrecognized document also replies immediately, naming the file so the client knows which one", async () => {
    // Two outstanding requirements — with only one, the sole-outstanding
    // fallback (resolveRequirementAssignment) would auto-match this file
    // regardless of identified=false; that's a different, already-covered
    // scenario (see the unit tests in documentIntakeReview.test.ts).
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות", "רישיון נהיגה"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: false,
      documentType: null,
      identificationConfidence: 0.1,
      matchedRequirementId: null,
      matchConfidence: 0,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "IMG_9931.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.unrec1");

    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("IMG_9931.jpg");
    expect(outbound[0].body).not.toContain("שלחת אותו בכוונה"); // never the wrong question for this case
  });

  it("a clean document and a blurry document in the same burst behave independently — one silent, one immediate", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "רישיון נהיגה"]);
    const idReq = requirements.find((r) => r.name === "תעודת זהות")!;
    const licenseReq = requirements.find((r) => r.name === "רישיון נהיגה")!;

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.97,
      matchedRequirementId: idReq.id,
      matchConfidence: 0.97,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.mix1");

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "רישיון נהיגה",
      identificationConfidence: 0.9,
      matchedRequirementId: licenseReq.id,
      matchConfidence: 0.85,
      readabilityIssue: "cropped_or_incomplete",
      readabilityIssueDetail: "רק חצי מהמסמך נראה בתמונה",
      clientMessageIfProblematic: "קיבלתי את רישיון הנהיגה, אבל רק חצי ממנו נראה בתמונה. אפשר לצלם מחדש את המסמך במלואו?",
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "license.jpg", null, Buffer.from("y"), "image/jpeg", "wamid.mix2");

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    const idDoc = docs.find((d) => d.fileName === "id.jpg")!;
    const licenseDoc = docs.find((d) => d.fileName === "license.jpg")!;
    expect(idDoc.status).toBe("approved");
    expect(licenseDoc.status).toBe("clarification_requested");

    // Exactly one outbound message — the immediate resend request for the
    // license photo. The valid ID card never gets its own per-document
    // acknowledgment (that's the 2-minute batch summary's job).
    const outbound = await db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.conversationId, conversationId), eq(schema.messages.direction, "outbound")));
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("רישיון הנהיגה");
  });
});

describe("processInboundAttachment — silence-window case review timer (conversations.pendingCaseReviewAt)", () => {
  it("a single document pushes the due-at roughly CASE_REVIEW_SILENCE_WINDOW_MS out", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "רישיון נהיגה"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
    });
    const before = Date.now();
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.timer1");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).not.toBeNull();
    const deltaMs = conversation.pendingCaseReviewAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThan(CASE_REVIEW_SILENCE_WINDOW_MS - 30_000);
    expect(deltaMs).toBeLessThan(CASE_REVIEW_SILENCE_WINDOW_MS + 30_000);
  });

  it("a second document arriving shortly after pushes the due-at further out (debounce/reset)", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות", "רישיון נהיגה"]);
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.timer2a");
    const [firstConversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    const firstDueAt = firstConversation.pendingCaseReviewAt!.getTime();

    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "רישיון נהיגה",
      identificationConfidence: 0.9,
      matchedRequirementId: requirements[1].id,
      matchConfidence: 0.9,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "license.jpg", null, Buffer.from("y"), "image/jpeg", "wamid.timer2b");
    const [secondConversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));

    expect(secondConversation.pendingCaseReviewAt!.getTime()).toBeGreaterThanOrEqual(firstDueAt);
  });

  it("never sets the timer while a post-completion extension is active — that flow uses its own nudge instead", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["דף חשבון בנק"]);
    await db.update(schema.collectionRequests).set({ extensionActive: true }).where(eq(schema.collectionRequests.id, requestId));
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "דף חשבון בנק",
      identificationConfidence: 0.9,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.9,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "bank.jpg", null, Buffer.from("z"), "image/jpeg", "wamid.timer3");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.pendingCaseReviewAt).toBeNull();
  });

  it("a document that completes the request right away clears any pendingCaseReviewAt rather than leaving it dangling", async () => {
    const { orgId, clientId, requestId, conversationId, requirements } = await seedRequest(["תעודת זהות"]);
    await db.update(schema.collectionRequests).set({ status: "active" }).where(eq(schema.collectionRequests.id, requestId));
    classifyDocumentViaVisionAI.mockResolvedValueOnce({
      identified: true,
      documentType: "תעודת זהות",
      identificationConfidence: 0.95,
      matchedRequirementId: requirements[0].id,
      matchConfidence: 0.95,
    });
    await processInboundAttachment(orgId, requestId, conversationId, clientId, "id.jpg", null, Buffer.from("x"), "image/jpeg", "wamid.timer4");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
    expect(conversation.pendingCaseReviewAt).toBeNull();
  });
});
