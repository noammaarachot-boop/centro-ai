"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { clientServices, collectionRequests, documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import {
  canTransition,
  checkCompletionGate,
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
  const db = await getDb();

  const [current] = await db
    .select()
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.id, collectionRequestId),
        eq(collectionRequests.organizationId, session.organizationId)
      )
    )
    .limit(1);
  if (!current) redirect("/collections");

  if (!canTransition(current.status, nextStatus)) {
    redirect(`/collections/${collectionRequestId}?error=invalid-transition`);
  }

  if (nextStatus === "completed") {
    const gateError = await checkCompletionGate(collectionRequestId);
    if (gateError) {
      redirect(
        `/collections/${collectionRequestId}?error=${encodeURIComponent(gateError)}`
      );
    }
  }

  await db
    .update(collectionRequests)
    .set({
      status: nextStatus,
      updatedAt: new Date(),
      completedAt: nextStatus === "completed" ? new Date() : current.completedAt,
    })
    .where(eq(collectionRequests.id, collectionRequestId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "collection_request.status_changed",
    description: `סטטוס בקשת האיסוף עודכן מ-${current.status} ל-${nextStatus}`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: current.clientId,
    metadata: { from: current.status, to: nextStatus },
  });

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
