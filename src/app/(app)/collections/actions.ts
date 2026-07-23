"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  clientServices,
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
  services,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import {
  applyTransition,
  snapshotServiceRequirements,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";
import { recordAdHocDocumentObservation } from "@/lib/clientDocumentProfile";
import { recordLearnedDocumentPattern } from "@/lib/documentLearning";
import { createPendingConfirmation } from "@/lib/pendingConfirmations";
import { uploadDocumentResiliently } from "@/lib/storage/driveAdapter";
import { SUPPORTED_EXTENSIONS } from "@/lib/ai/documentClassifier";

// The one place every mutation in this file gets the Collection Request
// from — every lookup by ID (client, service, document) must be proven to
// belong to the caller's organization before anything is read or written,
// never trusted from a bound argument alone (NFR-24.4: firms are fully
// isolated from each other).
async function getOrgScopedCollectionRequest(
  organizationId: string,
  collectionRequestId: string
) {
  const db = await getDb();
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!current) redirect("/collections");
  return current;
}

// A document is only ever addressed together with the Collection Request
// it belongs to, so this also checks documents.collectionRequestId
// matches — not just that the document exists somewhere in the org.
async function getScopedDocument(
  organizationId: string,
  collectionRequestId: string,
  documentId: string
) {
  const db = await getDb();
  const [document] = await db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.collectionRequestId, collectionRequestId),
        eq(documents.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!document) redirect(`/collections/${collectionRequestId}`);
  return document;
}

export async function createCollectionRequest(
  clientId: string,
  serviceId: string,
  formData: FormData
) {
  const session = await requireSession();
  const periodLabel = String(formData.get("periodLabel") ?? "").trim();
  if (!periodLabel) redirect(`/clients/${clientId}?error=period-required`);

  const db = await getDb();

  // Both the client and the service must themselves belong to this org —
  // otherwise an org-scoped clientServices row could be forged by pairing
  // one's own client with another organization's serviceId, then have
  // snapshotServiceRequirements copy that foreign service's requirement
  // templates into this org's new collection request.
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
    .limit(1);
  if (!client) redirect("/clients");

  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!service) redirect(`/clients/${clientId}`);

  const [assignment] = await db
    .select({ id: clientServices.id })
    .from(clientServices)
    .where(
      and(
        eq(clientServices.clientId, clientId),
        eq(clientServices.serviceId, serviceId)
      )
    )
    .limit(1);
  if (!assignment) redirect(`/clients/${clientId}?error=not-assigned`);

  const [collectionRequest] = await db
    .insert(collectionRequests)
    .values({
      organizationId: session.organizationId,
      clientId,
      serviceId,
      periodLabel,
      status: "draft",
    })
    .returning();

  await snapshotServiceRequirements(collectionRequest.id, serviceId, session.organizationId, clientId);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "collection_request.created",
    description: `נפתחה בקשת איסוף לתקופה ${periodLabel}`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
    collectionRequestId: collectionRequest.id,
  });

  redirect(`/collections/${collectionRequest.id}`);
}

export async function transitionStatus(
  collectionRequestId: string,
  nextStatus: CollectionRequestStatus
) {
  const session = await requireSession();
  const result = await applyTransition(
    session.organizationId,
    session.userId,
    "employee",
    collectionRequestId,
    nextStatus
  );

  if (!result.ok) {
    redirect(
      `/collections/${collectionRequestId}?error=${encodeURIComponent(result.error ?? "שגיאה")}`
    );
  }

  redirect(`/collections/${collectionRequestId}`);
}

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  approved: "אושר",
  rejected: "נדחה",
  needs_review: "דורש בדיקה",
};

// Attaching a real file here is optional (documents.fileName-only entry
// remains valid, e.g. logging something received outside the app), but
// when one is attached this is the one path in the product today with
// genuinely real bytes to upload — see driveAdapter.ts's module comment.
export async function addManualDocument(
  collectionRequestId: string,
  requirementId: string,
  formData: FormData
) {
  const session = await requireSession();
  const file = formData.get("file");
  const attachedFile = file instanceof File && file.size > 0 ? file : null;
  const fileName = String(formData.get("fileName") ?? "").trim() || attachedFile?.name || "";
  const status = String(formData.get("status") ?? "needs_review");

  if (!fileName) redirect(`/collections/${collectionRequestId}?error=filename-required`);

  if (attachedFile) {
    const extension = attachedFile.name.split(".").pop()?.toLowerCase() ?? "";
    if (!SUPPORTED_EXTENSIONS.includes(extension)) {
      redirect(`/collections/${collectionRequestId}?error=unsupported-file-type`);
    }
  }

  const current = await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);

  const db = await getDb();
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: session.organizationId,
      collectionRequestId,
      requirementId,
      fileName,
      status: status as "approved" | "rejected" | "needs_review",
    })
    .returning();

  if (status === "approved") {
    const fileBytes = attachedFile ? Buffer.from(await attachedFile.arrayBuffer()) : undefined;
    await uploadDocumentResiliently(
      session.organizationId,
      current.clientId,
      document.id,
      document.fileName,
      collectionRequestId,
      fileBytes,
      attachedFile?.type || undefined
    );
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.added_manually",
    description: `מסמך "${fileName}" נוסף ידנית (${DOCUMENT_STATUS_LABELS[status] ?? status})`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
    collectionRequestId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

// BR-11.3: employees may manually review and correct document
// classification/status — the human half of the pipeline that exists
// alongside the AI pipeline (M9), not just a placeholder for it.
export async function reviewDocument(
  collectionRequestId: string,
  documentId: string,
  formData: FormData
) {
  const session = await requireSession();
  const decision = String(formData.get("decision") ?? "");
  if (!["approved", "rejected", "needs_review"].includes(decision)) {
    redirect(`/collections/${collectionRequestId}`);
  }

  const current = await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);
  const scoped = await getScopedDocument(session.organizationId, collectionRequestId, documentId);

  const db = await getDb();
  // Cleared on any decision that reaches a final state — approved uses
  // them once below, rejected no longer needs them; only a repeated
  // needs_review decision leaves them in place for a possible later
  // approval. See documents.pendingFileContent's own comment for why
  // this exists at all.
  const clearPending = decision !== "needs_review";
  const [document] = await db
    .update(documents)
    .set({
      status: decision as "approved" | "rejected" | "needs_review",
      updatedAt: new Date(),
      ...(clearPending ? { pendingFileContent: null, pendingFileMimeType: null } : {}),
    })
    .where(eq(documents.id, documentId))
    .returning();
  if (!document) redirect(`/collections/${collectionRequestId}`);

  if (decision === "approved") {
    await uploadDocumentResiliently(
      session.organizationId,
      current.clientId,
      document.id,
      document.fileName,
      collectionRequestId,
      scoped.pendingFileContent ?? undefined,
      scoped.pendingFileMimeType ?? undefined
    );
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.reviewed",
    description: `מסמך "${document.fileName}" סומן כ${DOCUMENT_STATUS_LABELS[decision] ?? decision} על ידי עובד`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
    collectionRequestId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

// For documents AI classification couldn't confidently match (BR-11.3:
// manual review/correction) — an employee assigns it to the correct
// requirement by hand.
export async function assignDocumentRequirement(
  collectionRequestId: string,
  documentId: string,
  formData: FormData
) {
  const session = await requireSession();
  const requirementId = String(formData.get("requirementId") ?? "");
  const newTypeName = String(formData.get("newTypeName") ?? "").trim();
  if (!requirementId && !newTypeName) redirect(`/collections/${collectionRequestId}`);

  const current = await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);
  const scopedDocument = await getScopedDocument(session.organizationId, collectionRequestId, documentId);

  // requirementId is a bare form value — before it's trusted for anything
  // below (writing documents.requirementId, disclosing a requirement name
  // in a client-facing message, or recording a learned pattern), confirm
  // it actually names a requirement on *this* collection request. Without
  // this, a requirementId belonging to another organization's collection
  // request would still resolve (ids are unguessable but this is an
  // authorization boundary, not a secrecy one) and leak that
  // organization's requirement name into an outbound message here.
  const db = await getDb();
  let scopedRequirement: { id: string; name: string } | null = null;
  if (requirementId) {
    const [row] = await db
      .select({ id: collectionRequestRequirements.id, name: collectionRequestRequirements.name })
      .from(collectionRequestRequirements)
      .where(
        and(
          eq(collectionRequestRequirements.id, requirementId),
          eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
        )
      )
      .limit(1);
    if (!row) redirect(`/collections/${collectionRequestId}`);
    scopedRequirement = row;
  }

  // Milestone 6 (Observe, addition side): the document doesn't match any
  // *current* requirement at all — not a misclassification to correct
  // (that path stays below), but a genuinely new document type for this
  // client. Left unassigned (requirementId stays null, same as any other
  // unmatched document) and recorded as an observation instead; only
  // Suggested to the client once the same name recurs.
  if (newTypeName) {
    await recordAdHocDocumentObservation(
      session.organizationId,
      current.clientId,
      collectionRequestId,
      newTypeName,
      scopedDocument.fileName
    );

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "document.ad_hoc_type_observed",
      description: `מסמך "${scopedDocument.fileName}" סומן כסוג מסמך חדש: "${newTypeName}"`,
      actorType: "employee",
      actorUserId: session.userId,
      clientId: current.clientId,
      collectionRequestId,
    });

    redirect(`/collections/${collectionRequestId}`);
  }

  const [document] = await db
    .update(documents)
    .set({ requirementId, updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning();
  if (!document) redirect(`/collections/${collectionRequestId}`);

  // Milestone 3 ("Document Classification Learning") — the one place a
  // human manually assigns/corrects a document's requirement, so the one
  // place this can never be missed. Silently a no-op if the requirement
  // has no stable template identity to learn against (see
  // src/lib/documentLearning.ts).
  await recordLearnedDocumentPattern(
    session.organizationId,
    current.clientId,
    requirementId,
    document.fileName
  );

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.requirement_assigned",
    description: `מסמך "${document.fileName}" שויך ידנית לדרישה`,
    actorType: "employee",
    actorUserId: session.userId,
    collectionRequestId,
  });

  // Milestone 5 (Ch.3 "Confirm... through WhatsApp") — an employee who
  // immediately recognizes a document as a new recurring type can ask the
  // client to confirm right here, at the exact moment of manual
  // assignment, rather than waiting for Milestone 6's automatic
  // second-occurrence detection. Purely optional; unchecked by default.
  if (formData.get("askClient") === "on") {
    const question = `שלום! שמנו לב שקיבלנו מכם מסמך "${document.fileName}" ושייכנו אותו ל"${scopedRequirement?.name ?? "דרישה"}". האם נכון לבקש מסמך כזה גם באיסופים הבאים באופן קבוע? השיבו 'כן' או 'לא'.`;

    const confirmation = await createPendingConfirmation({
      organizationId: session.organizationId,
      clientId: current.clientId,
      collectionRequestId,
      kind: "document_profile_addition",
      payload: { requirementId, requirementName: scopedRequirement?.name, fileName: document.fileName },
      question,
    });

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "pending_confirmation.created",
      description: `נשלחה בקשת אישור ללקוח: "${question}"`,
      actorType: "employee",
      actorUserId: session.userId,
      clientId: current.clientId,
      collectionRequestId,
      metadata: { pendingConfirmationId: confirmation.id, kind: confirmation.kind },
    });
  }

  redirect(`/collections/${collectionRequestId}`);
}

// Lets an employee waive a specific, still-unsatisfied requirement for
// just this one cycle (e.g. "no vehicle expenses this month") —
// genuinely useful on its own (BR-11.2 otherwise leaves a Collection
// Request permanently unable to reach `completed` while anything remains
// outstanding), and also the only way Milestone 6's removal-detection
// can ever see a "recurring absence" in real completed-cycle history: a
// requirement can never complete a cycle while merely unsatisfied, only
// while genuinely absent from that cycle's snapshot.
export async function waiveRequirement(
  collectionRequestId: string,
  requirementId: string
) {
  const session = await requireSession();
  const current = await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);

  const db = await getDb();
  const [requirement] = await db
    .select({ id: collectionRequestRequirements.id, name: collectionRequestRequirements.name })
    .from(collectionRequestRequirements)
    .where(
      and(
        eq(collectionRequestRequirements.id, requirementId),
        eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
      )
    )
    .limit(1);
  if (!requirement) redirect(`/collections/${collectionRequestId}`);

  await db
    .delete(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.id, requirementId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "collection_request.requirement_waived",
    description: `הדרישה "${requirement.name}" סומנה כלא רלוונטית עבור מחזור זה`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
    collectionRequestId,
  });

  redirect(`/collections/${collectionRequestId}`);
}

// Ch.14: if a document is manually deleted from Google Drive, Centro
// keeps the database record and flips its status rather than removing
// it — the UI shows when it happened. This simulates that external event
// (there's no real Drive webhook yet) so the reconciliation behavior
// itself — the part that's actually specified — is real and testable.
export async function simulateDriveDeletion(
  collectionRequestId: string,
  documentId: string
) {
  const session = await requireSession();
  await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);
  await getScopedDocument(session.organizationId, collectionRequestId, documentId);

  const db = await getDb();
  const [document] = await db
    .update(documents)
    .set({
      status: "deleted_from_drive",
      driveDeletedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId))
    .returning();
  if (!document) redirect(`/collections/${collectionRequestId}`);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.deleted_from_drive",
    description: `מסמך "${document.fileName}" נמחק ידנית מ-Google Drive`,
    actorType: "system",
    collectionRequestId,
  });

  redirect(`/collections/${collectionRequestId}`);
}
