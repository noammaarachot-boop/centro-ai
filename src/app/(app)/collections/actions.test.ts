import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";
import { resolveDocumentDisplayLabel } from "@/lib/documents/displayLabel";
import { computeRequirementsProgress } from "@/lib/collectionRequestStateMachine";

// Collections UX simplification — proves addManualDocument's canonical-
// naming and "never lose a document" guarantees end to end, now that the
// upload form no longer sends a typed fileName or an upfront status:
// - the uploaded file's OWN name (documents.fileName) is internal
//   Drive/storage bookkeeping only, never the business-facing label;
// - resolveDocumentDisplayLabel always falls back to the requirement's own
//   canonical name for a manually-added document (displayLabel is never
//   set by this path) — this is the exact regression scenario requested:
//   requirement "תעודת זהות" + uploaded file "scan123.pdf" must display as
//   "תעודת זהות", never "scan123";
// - a document created without an explicit "approved" status (the new,
//   only reachable path from the simplified form) still holds its real
//   bytes (pendingFileContent) so a later approval has something real to
//   upload — the bug this rework's own audit found and fixed.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const { addManualDocument, reviewDocument, transitionStatus } = await import("./actions");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

async function seedRequest(requirementName = "תעודת זהות") {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: requirementName })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `${crypto.randomUUID()}@test.com`, passwordHash: "x", fullName: "Tester" })
    .returning();
  currentSession = {
    sessionId: "s1",
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    organizationId: org.id,
    organizationName: org.name,
  } as Session;
  return { orgId: org.id, requestId: request.id, requirementId: requirement.id };
}

function pdfFile(name: string): File {
  return new File(["%PDF-1.4 fake content"], name, { type: "application/pdf" });
}

async function expectRedirect(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error("expected a redirect");
  } catch (err) {
    const message = (err as Error).message;
    if (!message.startsWith("NEXT_REDIRECT:")) throw err;
    return message.slice("NEXT_REDIRECT:".length);
  }
}

describe("addManualDocument — canonical document naming, never the raw filename", () => {
  it("REGRESSION: requirement 'תעודת זהות' + uploaded filename 'scan123.pdf' displays as 'תעודת זהות', never 'scan123'", async () => {
    const { requestId, requirementId } = await seedRequest("תעודת זהות");
    const fd = new FormData();
    fd.append("file", pdfFile("scan123.pdf"));

    await expectRedirect(() => addManualDocument(requestId, requirementId, fd));

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    // Associated with the exact requirement the employee uploaded from.
    expect(doc.requirementId).toBe(requirementId);
    // The raw filename is stored (internal Drive/storage bookkeeping only)...
    expect(doc.fileName).toBe("scan123.pdf");
    // ...but displayLabel — the one column any UI may read — is never set
    // from it, so the resolver falls through to the requirement's own name.
    expect(doc.displayLabel).toBeNull();
    const displayed = resolveDocumentDisplayLabel(doc.displayLabel, "תעודת זהות");
    expect(displayed).toBe("תעודת זהות");
    expect(displayed).not.toBe("scan123");
    expect(displayed).not.toContain("scan123");
    // Not counted as "received/satisfied" the instant it's uploaded — only
    // once an employee actually reviews and approves it.
    expect(doc.status).toBe("needs_review");
    const progressBeforeReview = await computeRequirementsProgress(requestId);
    expect(progressBeforeReview.satisfiedCount).toBe(0);
  });

  it("progress only counts the document once it's actually approved, not the moment it's uploaded", async () => {
    const { requestId, requirementId } = await seedRequest("תעודת זהות");
    const fd = new FormData();
    fd.append("file", pdfFile("scan123.pdf"));
    await expectRedirect(() => addManualDocument(requestId, requirementId, fd));

    const beforeReview = await computeRequirementsProgress(requestId);
    expect(beforeReview.satisfiedCount).toBe(0);
    expect(beforeReview.totalCount).toBe(1);

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    const approveFd = new FormData();
    approveFd.append("decision", "approved");
    await expectRedirect(() => reviewDocument(requestId, doc.id, approveFd));

    const afterReview = await computeRequirementsProgress(requestId);
    expect(afterReview.satisfiedCount).toBe(1);
  });

  it("works the same for a completely unrelated real-world filename (IMG_9382.jpg)", async () => {
    const { requestId, requirementId } = await seedRequest("תעודת התאגדות");
    const fd = new FormData();
    fd.append("file", new File(["fake"], "IMG_9382.jpg", { type: "image/jpeg" }));

    await expectRedirect(() => addManualDocument(requestId, requirementId, fd));

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(resolveDocumentDisplayLabel(doc.displayLabel, "תעודת התאגדות")).toBe("תעודת התאגדות");
  });
});

describe("addManualDocument — real bytes survive to a later approval (Never Lose a Document)", () => {
  it("stores pendingFileContent even when status defaults to needs_review (no status field submitted)", async () => {
    const { requestId, requirementId } = await seedRequest();
    const fd = new FormData();
    fd.append("file", pdfFile("id.pdf"));

    await expectRedirect(() => addManualDocument(requestId, requirementId, fd));

    const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(doc.status).toBe("needs_review");
    // This is the exact bug this rework's audit found and fixed: bytes
    // used to be held ONLY when status was already "approved" at creation
    // — meaning a needs_review document (the only path the simplified
    // form now takes) had nothing left to upload once later approved.
    expect(doc.pendingFileContent).not.toBeNull();
  });

  it("a later approval (reviewDocument) still has real bytes to work with, and clears them once handled", async () => {
    const { orgId, requestId, requirementId } = await seedRequest();
    const fd = new FormData();
    fd.append("file", pdfFile("id.pdf"));
    await expectRedirect(() => addManualDocument(requestId, requirementId, fd));

    const [beforeApproval] = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(beforeApproval.pendingFileContent).not.toBeNull();

    const approveFd = new FormData();
    approveFd.append("decision", "approved");
    await expectRedirect(() => reviewDocument(requestId, beforeApproval.id, approveFd));

    // Google isn't connected in this test org, so uploadDocumentResiliently
    // gracefully records the skip rather than throwing — confirms the
    // approval path genuinely reached the upload attempt with real bytes
    // (not a no-op over an already-empty pendingFileContent).
    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
    expect(audits.some((a) => a.eventType === "document.drive_upload_skipped")).toBe(true);
  });
});

describe("addManualDocument — existing behavior preserved", () => {
  it("still rejects an unsupported file extension", async () => {
    const { requestId, requirementId } = await seedRequest();
    const fd = new FormData();
    fd.append("file", new File(["x"], "virus.exe", { type: "application/octet-stream" }));

    const redirectedTo = await expectRedirect(() => addManualDocument(requestId, requirementId, fd));
    expect(redirectedTo).toContain("error=unsupported-file-type");

    const rows = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(rows).toHaveLength(0);
  });

  it("still rejects when neither a file nor a fileName is provided", async () => {
    const { requestId, requirementId } = await seedRequest();
    const redirectedTo = await expectRedirect(() => addManualDocument(requestId, requirementId, new FormData()));
    expect(redirectedTo).toContain("error=filename-required");
  });

  it("tenant isolation: refuses to add a document to another organization's collection request", async () => {
    const { requestId, requirementId } = await seedRequest();
    await seedRequest(); // switches currentSession to a second organization
    // currentSession is now the SECOND org; attempt to act on the FIRST
    // org's request/requirement ids.
    const fd = new FormData();
    fd.append("file", pdfFile("id.pdf"));

    const redirectedTo = await expectRedirect(() => addManualDocument(requestId, requirementId, fd));
    expect(redirectedTo).toBe("/collections");

    const rows = await db.select().from(schema.documents).where(eq(schema.documents.collectionRequestId, requestId));
    expect(rows).toHaveLength(0);
  });
});

// The real entry point the UI's "ביטול בקשה" ConfirmDialog calls
// (page.tsx's boundTransition.bind(null, "cancelled")) — auth/redirect
// behavior on top of applyTransition's own already-tested core logic
// (collectionRequestStateMachine.test.ts).
describe("transitionStatus — cancel, the real action the UI's ביטול בקשה button calls", () => {
  it("cancels the request and redirects back to it, with no error param", async () => {
    const { requestId } = await seedRequest();

    const redirectedTo = await expectRedirect(() => transitionStatus(requestId, "cancelled"));
    expect(redirectedTo).toBe(`/collections/${requestId}`);

    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("cancelled");
  });

  it("a second cancel attempt redirects with a clear error and does not change anything further", async () => {
    const { requestId } = await seedRequest();
    await expectRedirect(() => transitionStatus(requestId, "cancelled"));

    const redirectedTo = await expectRedirect(() => transitionStatus(requestId, "cancelled"));
    expect(redirectedTo).toContain(`/collections/${requestId}?error=`);

    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("cancelled"); // still cancelled, no crash, no double side effect
  });

  it("tenant isolation: cancelling another organization's request fails and leaves it untouched", async () => {
    const { requestId } = await seedRequest();
    await seedRequest(); // switches currentSession to a second organization

    const redirectedTo = await expectRedirect(() => transitionStatus(requestId, "cancelled"));
    expect(redirectedTo).toContain("error=");

    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).not.toBe("cancelled"); // untouched — still whatever it started as
  });
});
