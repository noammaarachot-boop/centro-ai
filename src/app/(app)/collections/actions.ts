"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { clientServices, collectionRequests, documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import {
  applyTransition,
  snapshotServiceRequirements,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";

export async function createCollectionRequest(
  clientId: string,
  serviceId: string,
  formData: FormData
) {
  const session = await requireSession();
  const periodLabel = String(formData.get("periodLabel") ?? "").trim();
  if (!periodLabel) redirect(`/clients/${clientId}?error=period-required`);

  const db = await getDb();

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

  const db = await getDb();
  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(eq(collectionRequests.id, collectionRequestId))
    .limit(1);
  if (!current) redirect("/collections");

  await db.insert(documents).values({
    organizationId: session.organizationId,
    collectionRequestId,
    requirementId,
    fileName,
    status: status as "approved" | "rejected" | "needs_review",
  });

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.added_manually",
    description: `מסמך "${fileName}" נוסף ידנית (${DOCUMENT_STATUS_LABELS[status] ?? status})`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
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

  const db = await getDb();
  const [document] = await db
    .update(documents)
    .set({ status: decision as "approved" | "rejected" | "needs_review", updatedAt: new Date() })
    .where(eq(documents.id, documentId))
    .returning();
  if (!document) redirect(`/collections/${collectionRequestId}`);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "document.reviewed",
    description: `מסמך "${document.fileName}" סומן כ${DOCUMENT_STATUS_LABELS[decision] ?? decision} על ידי עובד`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/collections/${collectionRequestId}`);
}
