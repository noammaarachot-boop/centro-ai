import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
  services,
} from "@/db/schema";

export async function listCollectionRequests(organizationId: string) {
  const db = await getDb();
  return db
    .select({
      id: collectionRequests.id,
      status: collectionRequests.status,
      periodLabel: collectionRequests.periodLabel,
      createdAt: collectionRequests.createdAt,
      clientName: clients.name,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(eq(collectionRequests.organizationId, organizationId))
    .orderBy(desc(collectionRequests.createdAt));
}

export async function getCollectionRequest(
  organizationId: string,
  id: string
) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: collectionRequests.id,
      status: collectionRequests.status,
      periodLabel: collectionRequests.periodLabel,
      createdAt: collectionRequests.createdAt,
      completedAt: collectionRequests.completedAt,
      reviewDeadlineAt: collectionRequests.reviewDeadlineAt,
      deferralCount: collectionRequests.deferralCount,
      escalationReason: collectionRequests.escalationReason,
      clientId: clients.id,
      clientName: clients.name,
      serviceId: services.id,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(clients, eq(collectionRequests.clientId, clients.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(
      and(
        eq(collectionRequests.id, id),
        eq(collectionRequests.organizationId, organizationId)
      )
    )
    .limit(1);
  return row ?? null;
}

export async function listRequirementsWithDocuments(
  collectionRequestId: string
) {
  const db = await getDb();
  const requirements = await db
    .select()
    .from(collectionRequestRequirements)
    .where(
      eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
    );

  const requestDocuments = await db
    .select()
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  return requirements.map((requirement) => ({
    ...requirement,
    documents: requestDocuments.filter(
      (doc) => doc.requirementId === requirement.id
    ),
  }));
}

// Documents AI classification couldn't confidently match to any
// requirement (src/lib/ai/documentClassifier.ts) land here with
// requirementId null — still real, received documents that need a human
// to either assign them to a requirement or reject them, not documents
// that got silently dropped.
// Explicitly scoped to needs_review — not just "no requirementId" — so a
// document currently mid-flight through the Ch.6 3-way intake split
// (unsolicited_pending_confirmation / clarification_requested, both also
// requirementId-null while the client hasn't answered yet) never shows up
// here asking an employee to manually assign it. Those two are visible
// instead via listOpenConfirmations' own card, which shows the actual
// question awaiting the client's reply. Only a document that reached
// needs_review — as a genuine last resort, see
// src/lib/documentIntakeReview.ts — belongs in this "needs manual
// assignment" list.
export async function listUnmatchedDocuments(collectionRequestId: string) {
  const db = await getDb();
  return db
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.collectionRequestId, collectionRequestId),
        isNull(documents.requirementId),
        eq(documents.status, "needs_review")
      )
    );
}

// Every real WhatsApp-attachment document for this request, regardless of
// status or requirement (unlike listRequirementsWithDocuments/
// listUnmatchedDocuments, which only cover documents already tied to a
// requirement or sitting in needs_review) — the conversation thread's own
// display layer joins this back to messages.whatsappMessageId (the same
// id a real inbound attachment always shares with its document row) so a
// historical "[קובץ מצורף]" placeholder can be upgraded to the document's
// real resolveDocumentDisplayLabel() once it's known, without ever
// rewriting the stored message itself.
export async function listDocumentsByWhatsappMessageId(collectionRequestId: string) {
  const db = await getDb();
  return db
    .select({
      whatsappMessageId: documents.whatsappMessageId,
      displayLabel: documents.displayLabel,
      requirementId: documents.requirementId,
    })
    .from(documents)
    .where(and(eq(documents.collectionRequestId, collectionRequestId), isNotNull(documents.whatsappMessageId)));
}
