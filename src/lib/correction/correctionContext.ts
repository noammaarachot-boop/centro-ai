import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, documents, messages, pendingConfirmations } from "@/db/schema";
import { buildRequirementFacts, type RequirementFact } from "@/lib/requestQnA";

/**
 * Conversational correction layer — context-gathering only, no AI, no state
 * changes. The real gap this closes: nothing in the codebase before this
 * ever assembled "what just happened" for a client's new message to be
 * understood against — every existing classifier only ever saw either the
 * single currently-open question, or a bare requirement-name list. A
 * correction like "שלחתי בטעות" arriving right after a decision was already
 * applied needs to see that decision (and a short recent window around it),
 * not just the live open state.
 *
 * Every candidate (document or confirmation) is tagged with its real
 * database id — never a synthesized one — so the classifier's own returned
 * targetId can be validated by exact membership against the same list built
 * here, in the same call, rather than trusted blindly.
 */

const RECENT_DOCUMENT_STATUSES = ["approved", "unsolicited_approved", "identity_anomaly_confirmed"] as const;
const RECENT_CONFIRMATION_KINDS = ["identity_anomaly", "unsolicited_document"] as const;
const RECENT_DOCUMENTS_LIMIT = 5;
const RECENT_CONFIRMATIONS_LIMIT = 5;
const RECENT_MESSAGES_LIMIT = 8;

export interface CorrectionCandidateDocument {
  id: string;
  documentType: string | null;
  requirementName: string | null;
  extractedPersonName: string | null;
  extractedCompanyName: string | null;
  status: string;
  receivedAt: string;
}

export interface CorrectionCandidateConfirmation {
  id: string;
  kind: "identity_anomaly" | "unsolicited_document";
  question: string;
  resolvedAnswer: "confirmed" | "declined";
  resolvedAt: string;
}

export interface CorrectionOpenQuestion {
  id: string;
  kind: string;
  question: string;
}

export interface CorrectionRecentMessage {
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
}

export interface CorrectionContext {
  collectionRequestId: string;
  conversationId: string;
  requirementFacts: RequirementFact[];
  openQuestion: CorrectionOpenQuestion | null;
  recentDocuments: CorrectionCandidateDocument[];
  recentResolvedConfirmations: CorrectionCandidateConfirmation[];
  recentMessages: CorrectionRecentMessage[];
}

// Best-effort "what type of document was this" label — mirrors the same
// fallback every existing extra-document rename already uses (documentType
// when known, else the requirement it was matched to, else nothing).
function deriveDocumentType(fileName: string, requirementName: string | null): string | null {
  return requirementName ?? (fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName) ?? null;
}

export async function buildCorrectionContext(params: {
  collectionRequestId: string;
  conversationId: string;
}): Promise<CorrectionContext> {
  const db = await getDb();

  const requirementFacts = await buildRequirementFacts(params.collectionRequestId);

  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.conversationId, params.conversationId),
        eq(pendingConfirmations.status, "pending")
      )
    )
    .limit(2);
  const openQuestion: CorrectionOpenQuestion | null =
    openRows.length === 1 ? { id: openRows[0].id, kind: openRows[0].kind, question: openRows[0].question } : null;

  const recentDocs = await db
    .select({
      id: documents.id,
      fileName: documents.fileName,
      requirementId: documents.requirementId,
      status: documents.status,
      extractedPersonName: documents.extractedPersonName,
      extractedCompanyName: documents.extractedCompanyName,
      receivedAt: documents.receivedAt,
    })
    .from(documents)
    .where(
      and(
        eq(documents.collectionRequestId, params.collectionRequestId),
        inArray(documents.status, [...RECENT_DOCUMENT_STATUSES])
      )
    )
    .orderBy(desc(documents.receivedAt))
    .limit(RECENT_DOCUMENTS_LIMIT);

  const requirementIds = [...new Set(recentDocs.map((d) => d.requirementId).filter((id): id is string => !!id))];
  const requirementNameById = new Map<string, string>();
  if (requirementIds.length > 0) {
    const requirementRows = await db
      .select({ id: collectionRequestRequirements.id, name: collectionRequestRequirements.name })
      .from(collectionRequestRequirements)
      .where(inArray(collectionRequestRequirements.id, requirementIds));
    for (const row of requirementRows) requirementNameById.set(row.id, row.name);
  }

  const recentDocuments: CorrectionCandidateDocument[] = recentDocs.map((doc) => {
    const requirementName = doc.requirementId ? requirementNameById.get(doc.requirementId) ?? null : null;
    return {
      id: doc.id,
      documentType: deriveDocumentType(doc.fileName, requirementName),
      requirementName,
      extractedPersonName: doc.extractedPersonName,
      extractedCompanyName: doc.extractedCompanyName,
      status: doc.status,
      receivedAt: doc.receivedAt.toISOString(),
    };
  });

  const resolvedConfirmationRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, params.collectionRequestId),
        inArray(pendingConfirmations.kind, [...RECENT_CONFIRMATION_KINDS])
      )
    )
    .orderBy(desc(pendingConfirmations.respondedAt))
    .limit(RECENT_CONFIRMATIONS_LIMIT * 2); // status filtered in JS below, respondedAt is null for still-pending rows

  const recentResolvedConfirmations: CorrectionCandidateConfirmation[] = resolvedConfirmationRows
    .filter((row) => (row.status === "confirmed" || row.status === "declined") && row.respondedAt)
    .slice(0, RECENT_CONFIRMATIONS_LIMIT)
    .map((row) => ({
      id: row.id,
      kind: row.kind as "identity_anomaly" | "unsolicited_document",
      question: row.question,
      resolvedAnswer: row.status as "confirmed" | "declined",
      resolvedAt: row.respondedAt!.toISOString(),
    }));

  const recentMessageRows = await db
    .select({ direction: messages.direction, body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, params.conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_MESSAGES_LIMIT);
  const recentMessages: CorrectionRecentMessage[] = recentMessageRows
    .map((row) => ({ direction: row.direction, body: row.body, createdAt: row.createdAt.toISOString() }))
    .reverse();

  return {
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
    requirementFacts,
    openQuestion,
    recentDocuments,
    recentResolvedConfirmations,
    recentMessages,
  };
}
