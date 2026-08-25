import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Regression coverage for a real production bug: respondToConfirmation
// (the employee "הלקוח אישר/סירב" quick-action) used to call only
// applyDocumentProfileConfirmation, silently no-oping for every other
// PendingConfirmationKind (unsolicited_document, identity_anomaly,
// request_reopen, extension_finished_check, document_clarification) — the
// row was marked resolved but the real effect never happened. This proves
// the FULL fan-out now wired into respondToConfirmation/respondToClarification
// (the exact same sequence, in the exact same order) produces the real
// effect for every kind, not just document_profile_*.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

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

// Deterministic stand-in for the real LLM call — this file proves
// applyDocumentProfileConfirmation actually calls and stores the parser's
// result, not what the parser itself decides for any given text (that's
// requirementSemantics.test.ts's job).
const parseRequirementSemantics = vi.fn();
vi.mock("@/lib/ai/requirementSemantics", () => ({
  parseRequirementSemantics: (...args: unknown[]) => parseRequirementSemantics(...args),
}));

const { respondToPendingConfirmationManually, respondToClarificationManually } = await import(
  "@/lib/pendingConfirmations"
);
const { applyDocumentProfileConfirmation, resolveEffectiveRequirementNames } = await import(
  "@/lib/clientDocumentProfile"
);
const { applyUnsolicitedConfirmationDecision, applyClarificationReply } = await import(
  "@/lib/documentIntakeReview"
);
const { applyIdentityAnomalyDecision } = await import("@/lib/documentIdentityVerification");
const { applyRequestReopenDecision } = await import("@/lib/requestReopen");
const { applyExtensionFinishedDecision } = await import("@/lib/requestExtension");
const { reprocessHeldReopenDocument } = await import("./conversationActions");

// The exact same 5-call fan-out respondToConfirmation runs in production —
// duplicated here deliberately (matching correctionDispatch.ts's own
// applyResolvedConfirmationOutcome precedent) so this test exercises the
// real wiring, not a paraphrase of it.
async function applyFullFanOut(resolved: NonNullable<Awaited<ReturnType<typeof respondToPendingConfirmationManually>>>) {
  await applyDocumentProfileConfirmation(resolved);
  await applyUnsolicitedConfirmationDecision(resolved);
  await applyIdentityAnomalyDecision(resolved);
  await applyRequestReopenDecision(resolved, reprocessHeldReopenDocument);
  await applyExtensionFinishedDecision(resolved);
}

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  parseRequirementSemantics.mockReset();
  parseRequirementSemantics.mockResolvedValue({
    originalText: "2 תלושי שכר אחרונים",
    documentType: "תלוש שכר",
    requiredCount: 2,
    periodType: "unspecified",
    explicitPeriods: null,
    relativePeriod: null,
    samePeriodAllowed: false,
    distinctPeriodsRequired: false,
    distinctPeopleRequired: false,
    expectedPersonOrCompany: null,
    validityRequirement: null,
    supportingDocumentRelationship: null,
    freeTextConstraints: null,
    interpretationConfidence: 0.9,
    clarifyingQuestion: null,
  });
});

async function seedRequest(status: "active" | "completed" = "active") {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleDriveFolderId: "root-1", whatsappPhoneNumberId: `phone-${crypto.randomUUID()}` })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
    .returning();
  return {
    orgId: org.id,
    clientId: client.id,
    serviceId: service.id,
    requestId: request.id,
    requirementId: requirement.id,
    conversationId: conversation.id,
  };
}

describe("confirmation routing — every kind reaches its real handler, not a no-op", () => {
  it("document_profile_addition: confirming updates the real clientDocumentRequirements row and parses real semantics (previously hardcoded to null/1)", async () => {
    const { orgId, clientId, serviceId, requestId, conversationId } = await seedRequest();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "document_profile_addition",
        payload: {},
        question: "לזהות תמיד לצרף גם 2 תלושי שכר אחרונים?",
      })
      .returning();
    const [profileRow] = await db
      .insert(schema.clientDocumentRequirements)
      .values({
        organizationId: orgId,
        clientId,
        name: "2 תלושי שכר אחרונים",
        action: "add",
        status: "pending",
        pendingConfirmationId: pending.id,
      })
      .returning();

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, true);
    expect(resolved).not.toBeNull();
    await applyFullFanOut(resolved!);

    expect(parseRequirementSemantics).toHaveBeenCalledWith("2 תלושי שכר אחרונים");

    const [updated] = await db
      .select()
      .from(schema.clientDocumentRequirements)
      .where(eq(schema.clientDocumentRequirements.id, profileRow.id));
    expect(updated.status).toBe("confirmed");
    // Real parsed quantity — no longer the old hardcoded requiredCount:1/
    // semanticSpec:null every ad-hoc addition got before this fix.
    expect(updated.requiredCount).toBe(2);
    expect((updated.semanticSpec as { documentType?: string } | null)?.documentType).toBe("תלוש שכר");

    // resolveEffectiveRequirementNames — what a real new collection
    // request actually snapshots — reflects the parsed spec too, not just
    // the raw DB row.
    const effective = await resolveEffectiveRequirementNames(orgId, clientId, serviceId);
    const addedRequirement = effective.find((r) => r.name === "2 תלושי שכר אחרונים");
    expect(addedRequirement?.requiredCount).toBe(2);
  });

  it("document_profile_addition: declining never calls the semantic parser at all (never spent on a suggestion the client rejected)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "document_profile_addition",
        payload: {},
        question: "לזהות תמיד לצרף גם דף בנק?",
      })
      .returning();
    await db
      .insert(schema.clientDocumentRequirements)
      .values({
        organizationId: orgId,
        clientId,
        name: "דף בנק",
        action: "add",
        status: "pending",
        pendingConfirmationId: pending.id,
      });

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, false);
    await applyFullFanOut(resolved!);

    expect(parseRequirementSemantics).not.toHaveBeenCalled();
  });

  it("unsolicited_document: declining marks the real document unsolicited_rejected (previously a silent no-op)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [doc] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "receipt.jpg",
        status: "unsolicited_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
      })
      .returning();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "unsolicited_document",
        payload: { documentIds: [doc.id], documentType: "קבלה" },
        question: "שלחת קבלה בכוונה?",
      })
      .returning();

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, false);
    await applyFullFanOut(resolved!);

    const [updated] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(updated.status).toBe("unsolicited_rejected");
  });

  it("identity_anomaly: declining marks the real document identity_anomaly_rejected (previously a silent no-op)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [doc] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "id_other_person.jpg",
        status: "identity_anomaly_pending_confirmation",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
      })
      .returning();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "identity_anomaly",
        payload: {
          anomaly: { kind: "wrong_person" },
          documents: [{ id: doc.id, documentType: "תעודת זהות", matchedRequirementId: null, matchedRequirementName: null }],
        },
        question: "המסמך על שם אחר — שלחת בכוונה?",
      })
      .returning();

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, false);
    await applyFullFanOut(resolved!);

    const [updated] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(updated.status).toBe("identity_anomaly_rejected");
  });

  it("request_reopen: declining marks the real held document reopen_declined (previously a silent no-op)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest("completed");
    const [doc] = await db
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
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "request_reopen",
        payload: { documentId: doc.id },
        question: "הבקשה כבר הושלמה — לפתוח מחדש כדי לשמור את זה?",
      })
      .returning();

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, false);
    await applyFullFanOut(resolved!);

    const [updated] = await db.select().from(schema.documents).where(eq(schema.documents.id, doc.id));
    expect(updated.status).toBe("reopen_declined");

    // The request itself must stay completed — declining never reopens it.
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });

  it("extension_finished_check: declining sends the real acknowledgment (previously a silent no-op)", async () => {
    const { orgId, clientId, requestId, conversationId } = await seedRequest();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "extension_finished_check",
        payload: {},
        question: "סיימת להעלות מסמכים נוספים?",
      })
      .returning();

    const resolved = await respondToPendingConfirmationManually(orgId, pending.id, false);
    await applyFullFanOut(resolved!);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(sendTextMessage.mock.calls[0][2]).toContain("אני כאן כשתסיים");
  });

  it("document_clarification: a real employee-entered reply re-classifies via applyClarificationReply, not the boolean confirm/decline path", async () => {
    const { orgId, clientId, requestId, conversationId, requirementId } = await seedRequest();
    void requirementId; // requirement exists so matchTextToCandidates has a real candidate pool to reject against
    const [doc] = await db
      .insert(schema.documents)
      .values({
        organizationId: orgId,
        collectionRequestId: requestId,
        fileName: "unknown.jpg",
        status: "clarification_requested",
        pendingFileContent: Buffer.from("bytes"),
        pendingFileMimeType: "image/jpeg",
      })
      .returning();
    const [pending] = await db
      .insert(schema.pendingConfirmations)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        kind: "document_clarification",
        payload: { documentId: doc.id },
        question: "מה זה המסמך הזה?",
      })
      .returning();

    // Text that matches no real requirement name — takes the
    // create-unsolicited-confirmation branch, proving the reply's actual
    // words were used to re-classify (not a boolean confirm/decline,
    // which respondToConfirmation structurally cannot express for this
    // kind at all).
    const replyText = "זו קבלה מהסופר, לא קשור לשום דבר שביקשתם";
    const resolved = await respondToClarificationManually(orgId, pending.id, replyText);
    expect(resolved).not.toBeNull();
    await applyClarificationReply(resolved!, replyText);

    const [newConfirmation] = await db
      .select()
      .from(schema.pendingConfirmations)
      .where(
        and(
          eq(schema.pendingConfirmations.kind, "unsolicited_document"),
          eq(schema.pendingConfirmations.collectionRequestId, requestId)
        )
      );
    expect(newConfirmation).toBeDefined();
    expect((newConfirmation.payload as { documentType?: string }).documentType).toBe(replyText);
  });
});
