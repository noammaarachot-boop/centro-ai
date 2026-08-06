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
const { runCaseReview } = await import("@/lib/caseReview");
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

    // "Centro checks the case, not the document" — nothing was actually
    // asked yet while the client might still be sending more documents;
    // both unsolicited documents are only held (deferredReviewKind set),
    // no pendingConfirmation exists until the case review runs.
    expect(unsolicited.every((d) => d.deferredReviewKind === "unsolicited_document")).toBe(true);
    const confirmationsBeforeReview = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    expect(confirmationsBeforeReview).toHaveLength(0);

    // Only once the client signals they're done does the whole case get
    // reviewed together — a real "was this intentional?" question for
    // each (two different document types, so two separate groups).
    await runCaseReview(orgId, clientId, requestId);
    const openConfirmations = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(eq(schema.pendingConfirmations.collectionRequestId, requestId));
    const unsolicitedConfirmations = openConfirmations.filter((c) => c.kind === "unsolicited_document");
    expect(unsolicitedConfirmations).toHaveLength(2);
    expect(unsolicitedConfirmations.every((c) => c.status === "pending")).toBe(true);

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
    const { orgId, clientId, requestId, conversationId } = await seedRequest(["תעודת זהות"]);
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
});
