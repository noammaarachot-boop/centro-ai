"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import {
  clientServices,
  clients,
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
import { recordLearnedDocumentPattern } from "@/lib/documentLearning";
import { OperationFailedError } from "@/lib/resilience";
import { uploadDocument } from "@/lib/storage/driveAdapter";

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

// FR-15.3: employees are notified only when automation genuinely can't
// recover — withRetry (src/lib/resilience.ts) already exhausted retries
// before this is ever reached. BR-15.1: the failure is logged and the
// document stays approved-but-unfiled; it must never crash the action or
// leave the Collection Request in a broken state.
async function uploadDocumentResiliently(
  organizationId: string,
  clientId: string,
  documentId: string,
  fileName: string,
  collectionRequestId: string
) {
  try {
    await uploadDocument(clientId, documentId);
  } catch (error) {
    if (!(error instanceof OperationFailedError)) throw error;
    await recordAuditEvent({
      organizationId,
      eventType: "document.drive_upload_failed",
      description: `העלאת "${fileName}" ל-Drive נכשלה לאחר ניסיונות חוזרים - דורש בדיקת עובד`,
      actorType: "system",
      clientId,
      collectionRequestId,
    });
  }
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

  await snapshotServiceRequirements(collectionRequest.id, serviceId);

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

export async function addManualDocument(
  collectionRequestId: string,
  requirementId: string,
  formData: FormData
) {
  const session = await requireSession();
  const fileName = String(formData.get("fileName") ?? "").trim();
  const status = String(formData.get("status") ?? "needs_review");

  if (!fileName) redirect(`/collections/${collectionRequestId}?error=filename-required`);

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
    await uploadDocumentResiliently(
      session.organizationId,
      current.clientId,
      document.id,
      document.fileName,
      collectionRequestId
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
  await getScopedDocument(session.organizationId, collectionRequestId, documentId);

  const db = await getDb();
  const [document] = await db
    .update(documents)
    .set({ status: decision as "approved" | "rejected" | "needs_review", updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning();
  if (!document) redirect(`/collections/${collectionRequestId}`);

  if (decision === "approved") {
    await uploadDocumentResiliently(
      session.organizationId,
      current.clientId,
      document.id,
      document.fileName,
      collectionRequestId
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
  if (!requirementId) redirect(`/collections/${collectionRequestId}`);

  const current = await getOrgScopedCollectionRequest(session.organizationId, collectionRequestId);
  await getScopedDocument(session.organizationId, collectionRequestId, documentId);

  const db = await getDb();
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
