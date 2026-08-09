import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, documents, employeeReviewItems, messages, pendingConfirmations } from "@/db/schema";
import { buildRequirementFacts, type RequirementFact } from "@/lib/requestQnA";

/**
 * The unified document-conversation understanding layer's context builder —
 * pure data-gathering, no AI, no state changes. The real gap this closes:
 * nothing in this codebase before it ever assembled "everything relevant
 * that's happened in this conversation" for a client's new message to be
 * understood against — every classifier only ever saw either the single
 * currently-open question, or a bare requirement-name list.
 *
 * Every candidate (document, confirmation, or review item) is tagged with
 * its real database id — never a synthesized one — so the classifier's own
 * returned targetId can be validated by exact membership against the same
 * list built here, in the same call, rather than trusted blindly.
 *
 * Employee-review items (src/lib/employeeReview.ts) are included precisely
 * because they're exactly the kind of "still-relevant, not-yet-settled"
 * state a later client message routinely refers back to (found the
 * document a review question was about, changed their mind, added a
 * detail) — without this, that whole class of message had no anchor to
 * connect to and silently degraded to "לא הצלחתי להבין".
 */

const RECENT_DOCUMENT_STATUSES = ["approved", "unsolicited_approved", "identity_anomaly_confirmed"] as const;
const RECENT_CONFIRMATION_KINDS = ["identity_anomaly", "unsolicited_document"] as const;
const RECENT_DOCUMENTS_LIMIT = 5;
const RECENT_CONFIRMATIONS_LIMIT = 5;
const RECENT_REVIEW_ITEMS_LIMIT = 5; // per status (pending / resolved), not combined
// Widened from the original 8 — a second, cheaper safety net alongside the
// structured reviewItems/recentResolvedConfirmations lists above: raw
// scrollback so a longer exchange doesn't lose everything once the
// structured lists' own limits are exceeded.
const RECENT_MESSAGES_LIMIT = 14;

export interface ConversationCandidateDocument {
  id: string;
  documentType: string | null;
  requirementName: string | null;
  extractedPersonName: string | null;
  extractedCompanyName: string | null;
  status: string;
  receivedAt: string;
}

export interface ConversationCandidateConfirmation {
  id: string;
  kind: "identity_anomaly" | "unsolicited_document";
  question: string;
  resolvedAnswer: "confirmed" | "declined";
  resolvedAt: string;
}

export interface ConversationCandidateReviewItem {
  id: string;
  category: string;
  clientQuestion: string;
  gist: string | null;
  status: "pending" | "resolved";
  createdAt: string;
}

export interface ConversationOpenQuestion {
  id: string;
  kind: string;
  question: string;
}

export interface ConversationRecentMessage {
  direction: "inbound" | "outbound";
  body: string;
  createdAt: string;
}

export interface ConversationContext {
  collectionRequestId: string;
  conversationId: string;
  requirementFacts: RequirementFact[];
  openQuestion: ConversationOpenQuestion | null;
  recentDocuments: ConversationCandidateDocument[];
  recentResolvedConfirmations: ConversationCandidateConfirmation[];
  reviewItems: ConversationCandidateReviewItem[];
  recentMessages: ConversationRecentMessage[];
}

// Best-effort "what type of document was this" label — mirrors the same
// fallback every existing extra-document rename already uses (documentType
// when known, else the requirement it was matched to, else nothing).
function deriveDocumentType(fileName: string, requirementName: string | null): string | null {
  return requirementName ?? (fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName) ?? null;
}

export async function buildConversationContext(params: {
  collectionRequestId: string;
  conversationId: string;
}): Promise<ConversationContext> {
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
  const openQuestion: ConversationOpenQuestion | null =
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

  const recentDocuments: ConversationCandidateDocument[] = recentDocs.map((doc) => {
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

  const recentResolvedConfirmations: ConversationCandidateConfirmation[] = resolvedConfirmationRows
    .filter((row) => (row.status === "confirmed" || row.status === "declined") && row.respondedAt)
    .slice(0, RECENT_CONFIRMATIONS_LIMIT)
    .map((row) => ({
      id: row.id,
      kind: row.kind as "identity_anomaly" | "unsolicited_document",
      question: row.question,
      resolvedAnswer: row.status as "confirmed" | "declined",
      resolvedAt: row.respondedAt!.toISOString(),
    }));

  const reviewItemRows = await db
    .select({
      id: employeeReviewItems.id,
      category: employeeReviewItems.category,
      clientQuestion: employeeReviewItems.clientQuestion,
      understoodContext: employeeReviewItems.understoodContext,
      status: employeeReviewItems.status,
      createdAt: employeeReviewItems.createdAt,
    })
    .from(employeeReviewItems)
    .where(eq(employeeReviewItems.collectionRequestId, params.collectionRequestId))
    .orderBy(desc(employeeReviewItems.createdAt));

  const pendingReviewItems = reviewItemRows.filter((r) => r.status === "pending").slice(0, RECENT_REVIEW_ITEMS_LIMIT);
  const resolvedReviewItems = reviewItemRows.filter((r) => r.status === "resolved").slice(0, RECENT_REVIEW_ITEMS_LIMIT);
  const reviewItems: ConversationCandidateReviewItem[] = [...pendingReviewItems, ...resolvedReviewItems].map((row) => ({
    id: row.id,
    category: row.category,
    clientQuestion: row.clientQuestion,
    gist: (row.understoodContext as { gist?: string } | null)?.gist ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  }));

  const recentMessageRows = await db
    .select({ direction: messages.direction, body: messages.body, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, params.conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(RECENT_MESSAGES_LIMIT);
  const recentMessages: ConversationRecentMessage[] = recentMessageRows
    .map((row) => ({ direction: row.direction, body: row.body, createdAt: row.createdAt.toISOString() }))
    .reverse();

  return {
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
    requirementFacts,
    openQuestion,
    recentDocuments,
    recentResolvedConfirmations,
    reviewItems,
    recentMessages,
  };
}
