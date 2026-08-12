import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clientConversationFocus,
  collectionRequestRequirements,
  collectionRequests,
  conversations,
  documents,
  employeeReviewItems,
  messages,
  organizations,
  pendingConfirmations,
  services,
} from "@/db/schema";
import { buildRequirementFacts, type RequirementFact } from "@/lib/requestQnA";
import { listActivePolicies } from "@/lib/policyKnowledgeBase";
import type { ConfirmedFocus, DiscourseEntity } from "@/lib/conversation/conversationReasoning";

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

// Phase 1 additions (conversation-intelligence redesign) — self-description
// of the case, organization, and sibling requests a human assistant reading
// the file would already know. Populated for real; not yet consumed by
// classifyConversationIntent's prompt (that's Phase 3) — adding them here
// first, with their own tests, keeps this a pure data-layer change.
export interface ConversationActiveRequestInfo {
  collectionRequestId: string;
  serviceName: string;
  periodLabel: string;
  status: string;
  createdAt: string;
}

export interface ConversationOrganizationInfo {
  name: string;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessDays: string;
  timezone: string;
}

export interface ConversationSiblingRequest {
  collectionRequestId: string;
  conversationId: string;
  serviceName: string;
  periodLabel: string;
  status: string;
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
  // Confirmed durable focus for this client, if any — see
  // client_conversation_focus's schema doc comment. Always read fresh;
  // never assumed still valid without checking it still points at an open
  // request (see buildConversationContext's own implementation below).
  confirmedFocus: ConfirmedFocus | null;
  activeRequest: ConversationActiveRequestInfo;
  organization: ConversationOrganizationInfo;
  // Lightweight only (id/service/period/status) — deliberately NOT deep
  // context (no requirementFacts/documents) for every open sibling request,
  // to keep the token budget bounded. Enough for a cross-request reference
  // ("ומה עם הבקשה השנייה?"); Phase 2/3 resolves what to do with it.
  otherOpenRequests: ConversationSiblingRequest[];
  // Real, current candidates recentMessages' pronouns/ordinals might refer
  // to — never a parse of past outbound text, never persisted. See
  // DiscourseEntity's own doc comment (conversationReasoning.ts).
  recentDiscourseEntities: DiscourseEntity[];
  // Phase 3 addition — office-approved policy knowledge (policyKnowledgeBase.ts),
  // compact (id/question/decision only, no metadata), as one more grounded-fact
  // source ANSWER may cite. Reused verbatim from the existing, already-proven
  // mechanism (handlePotentialReviewQuestion's policy-match-first step) — not
  // a new policy system, just made available earlier in the reasoning flow.
  activePolicies: ConversationPolicyFact[];
}

export interface ConversationPolicyFact {
  id: string;
  questionSummary: string;
  decisionText: string;
}

// Best-effort "what type of document was this" label — mirrors the same
// fallback every existing extra-document rename already uses (documentType
// when known, else the requirement it was matched to, else nothing).
function deriveDocumentType(fileName: string, requirementName: string | null): string | null {
  return requirementName ?? (fileName.includes(".") ? fileName.slice(0, fileName.lastIndexOf(".")) : fileName) ?? null;
}

export async function buildConversationContext(params: {
  organizationId: string;
  clientId: string;
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

  // Self-description of the active request/organization — a human
  // assistant reading the case file would already know both.
  const [activeRequestRow] = await db
    .select({
      periodLabel: collectionRequests.periodLabel,
      status: collectionRequests.status,
      createdAt: collectionRequests.createdAt,
      serviceName: services.name,
    })
    .from(collectionRequests)
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(eq(collectionRequests.id, params.collectionRequestId))
    .limit(1);
  const activeRequest: ConversationActiveRequestInfo = {
    collectionRequestId: params.collectionRequestId,
    serviceName: activeRequestRow?.serviceName ?? "",
    periodLabel: activeRequestRow?.periodLabel ?? "",
    status: activeRequestRow?.status ?? "",
    createdAt: activeRequestRow?.createdAt.toISOString() ?? "",
  };

  const [organizationRow] = await db
    .select({
      name: organizations.name,
      businessHoursStart: organizations.businessHoursStart,
      businessHoursEnd: organizations.businessHoursEnd,
      businessDays: organizations.businessDays,
      timezone: organizations.timezone,
    })
    .from(organizations)
    .where(eq(organizations.id, params.organizationId))
    .limit(1);
  const organization: ConversationOrganizationInfo = {
    name: organizationRow?.name ?? "",
    businessHoursStart: organizationRow?.businessHoursStart ?? "",
    businessHoursEnd: organizationRow?.businessHoursEnd ?? "",
    businessDays: organizationRow?.businessDays ?? "",
    timezone: organizationRow?.timezone ?? "",
  };

  // Confirmed durable focus — read fresh, never trusted past whether it
  // still points at a genuinely open request (see client_conversation_focus's
  // own schema doc comment: this row is authoritative only for what it
  // currently points at, not forever).
  const [focusRow] = await db
    .select({
      collectionRequestId: clientConversationFocus.collectionRequestId,
      source: clientConversationFocus.source,
      setAt: clientConversationFocus.setAt,
      requestStatus: collectionRequests.status,
    })
    .from(clientConversationFocus)
    .innerJoin(collectionRequests, eq(clientConversationFocus.collectionRequestId, collectionRequests.id))
    .where(eq(clientConversationFocus.clientId, params.clientId))
    .limit(1);
  const confirmedFocus: ConfirmedFocus | null =
    focusRow && focusRow.requestStatus !== "completed" && focusRow.requestStatus !== "cancelled"
      ? { collectionRequestId: focusRow.collectionRequestId, source: focusRow.source, setAt: focusRow.setAt.toISOString() }
      : null;

  // Lightweight sibling requests — this client's other open conversations,
  // id/service/period/status only (no deep per-request context), enough for
  // a cross-request reference without exploding the token budget.
  const siblingRows = await db
    .select({
      conversationId: conversations.id,
      collectionRequestId: conversations.collectionRequestId,
      status: conversations.status,
      periodLabel: collectionRequests.periodLabel,
      serviceName: services.name,
    })
    .from(conversations)
    .innerJoin(collectionRequests, eq(conversations.collectionRequestId, collectionRequests.id))
    .innerJoin(services, eq(collectionRequests.serviceId, services.id))
    .where(and(eq(conversations.clientId, params.clientId), ne(conversations.id, params.conversationId), ne(conversations.status, "closed")));
  const otherOpenRequests: ConversationSiblingRequest[] = siblingRows.map((row) => ({
    collectionRequestId: row.collectionRequestId,
    conversationId: row.conversationId,
    serviceName: row.serviceName,
    periodLabel: row.periodLabel,
    status: row.status,
  }));

  // Real, current candidates for this turn's reference resolution (Phase 2)
  // — assembled from data already fetched above, never from parsing past
  // outbound text. Deliberately no attempt here to guess which one "the
  // first one" means; that reasoning belongs to Phase 2/3, using this list
  // together with recentMessages' own literal text.
  const recentDiscourseEntities: DiscourseEntity[] = [
    { kind: "collection_request", id: activeRequest.collectionRequestId, label: `${activeRequest.serviceName} — ${activeRequest.periodLabel}` },
    ...otherOpenRequests.map((r) => ({
      kind: "collection_request" as const,
      id: r.collectionRequestId,
      label: `${r.serviceName} — ${r.periodLabel}`,
    })),
    ...recentDocuments.map((d) => ({ kind: "document" as const, id: d.id, label: d.documentType ?? d.requirementName ?? "מסמך" })),
    ...requirementFacts.map((f) => ({ kind: "requirement" as const, id: f.id, label: f.description })),
    ...reviewItems.map((r) => ({ kind: "review_item" as const, id: r.id, label: r.clientQuestion })),
  ];

  const activePolicyRows = await listActivePolicies(params.organizationId);
  const activePolicies: ConversationPolicyFact[] = activePolicyRows.map((p) => ({
    id: p.id,
    questionSummary: p.questionSummary,
    decisionText: p.decisionText,
  }));

  return {
    collectionRequestId: params.collectionRequestId,
    conversationId: params.conversationId,
    requirementFacts,
    openQuestion,
    recentDocuments,
    recentResolvedConfirmations,
    reviewItems,
    recentMessages,
    confirmedFocus,
    activeRequest,
    organization,
    otherOpenRequests,
    recentDiscourseEntities,
    activePolicies,
  };
}
