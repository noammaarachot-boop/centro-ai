import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { approvedPolicies, clients, employeeReviewItems, reviewItemCategory } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import { listActivePolicies, matchClientQuestionToPolicy, renderPolicyAnswer } from "@/lib/policyKnowledgeBase";

/**
 * The generic, non-blocking "AI understood a document-related question but
 * has no confident authority to answer it alone" pathway — the single
 * place that implements the two-step check: try a matching approved
 * policy first (the learning loop), fall back to opening a review item
 * that's visible in the central dashboard queue. Never pauses the rest of
 * the conversation — the caller (the unified conversation-understanding
 * layer) continues handling everything else normally regardless of the
 * outcome here.
 */

export type ReviewItemCategory = (typeof reviewItemCategory.enumValues)[number];

const REVIEW_QUESTION_RECEIVED_MESSAGE = "העברתי את השאלה לבדיקה מול המשרד ואעדכן אותך כשאקבל תשובה.";

export type HandlePotentialReviewQuestionResult =
  | { outcome: "answered_by_policy"; policyId: string }
  | { outcome: "opened_review_item"; reviewItemId: string };

export async function handlePotentialReviewQuestion(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  clientQuestion: string;
  category: ReviewItemCategory;
  relatedRequirementId: string | null;
  understoodContext?: { relatedRequirementName: string | null; gist: string };
}): Promise<HandlePotentialReviewQuestionResult> {
  const activePolicies = await listActivePolicies(params.organizationId);
  const match = await matchClientQuestionToPolicy(params.clientQuestion, activePolicies);

  if (match.policyId) {
    const policy = activePolicies.find((p) => p.id === match.policyId)!;
    const answer = await renderPolicyAnswer(params.clientQuestion, policy);
    await sendOutboundMessage(params.organizationId, params.conversationId, answer, "ai", "manual", undefined, true);
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "policy.matched_and_answered",
      description: `שאלת הלקוח נענתה אוטומטית לפי מדיניות מאושרת: "${policy.questionSummary}"`,
      actorType: "ai",
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      metadata: { policyId: policy.id, confidence: match.confidence, clientQuestion: params.clientQuestion },
    });
    return { outcome: "answered_by_policy", policyId: policy.id };
  }

  const db = await getDb();
  // ESCALATE dedup (Phase 4) — a retry/redelivery of the same inbound
  // message calls this with the exact same clientQuestion text. The real,
  // race-safe guarantee is the partial unique index
  // (employee_review_items_open_question_idx, schema.ts) — onConflictDoNothing
  // means two genuinely concurrent attempts can never both insert; only one
  // of them ever sends the client-facing acknowledgment / records
  // review_item.opened. A client asking a NEW question always has
  // different literal wording, so a real second question is never
  // suppressed by this.
  const [reviewItem] = await db
    .insert(employeeReviewItems)
    .values({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: params.conversationId,
      clientQuestion: params.clientQuestion,
      category: params.category,
      relatedRequirementId: params.relatedRequirementId,
      understoodContext: params.understoodContext ?? null,
      status: "pending",
    })
    .onConflictDoNothing({
      target: [employeeReviewItems.collectionRequestId, employeeReviewItems.clientQuestion],
      where: sql`${employeeReviewItems.status} = 'pending'`,
    })
    .returning();

  if (!reviewItem) {
    // Lost the race (or this is a retry of an already-open identical
    // question) — the existing pending row is authoritative; return it
    // without sending a second acknowledgment or a second audit event.
    const [existing] = await db
      .select({ id: employeeReviewItems.id })
      .from(employeeReviewItems)
      .where(
        and(
          eq(employeeReviewItems.collectionRequestId, params.collectionRequestId),
          eq(employeeReviewItems.clientQuestion, params.clientQuestion),
          eq(employeeReviewItems.status, "pending")
        )
      )
      .limit(1);
    // Defensive only — the unique index guarantees this row exists; if it
    // somehow doesn't (e.g. resolved between the conflict and this read),
    // there is nothing left to report back safely, so surface that plainly
    // rather than fabricate an id.
    if (!existing) throw new Error("employee review item insert conflicted but no matching pending row was found");
    return { outcome: "opened_review_item", reviewItemId: existing.id };
  }

  await sendOutboundMessage(params.organizationId, params.conversationId, REVIEW_QUESTION_RECEIVED_MESSAGE, "ai", "manual", undefined, true);
  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "review_item.opened",
    description: `נפתח פריט לבדיקת עובד: "${params.clientQuestion}"`,
    actorType: "ai",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { reviewItemId: reviewItem.id, category: params.category },
  });

  return { outcome: "opened_review_item", reviewItemId: reviewItem.id };
}

export interface ResolveEmployeeReviewItemResult {
  ok: boolean;
  error?: string;
}

// The office employee's resolution action. promoteToPolicy defaults false
// at every call site that doesn't explicitly pass true — the UI's opt-in
// checkbox is the only thing that should ever set it, never inferred.
export async function resolveEmployeeReviewItem(params: {
  organizationId: string;
  actorUserId: string;
  reviewItemId: string;
  resolutionText: string;
  promoteToPolicy: boolean;
  policyQuestionSummary?: string;
  policyDecisionText?: string;
}): Promise<ResolveEmployeeReviewItemResult> {
  const db = await getDb();
  const [reviewItem] = await db.select().from(employeeReviewItems).where(eq(employeeReviewItems.id, params.reviewItemId)).limit(1);
  if (!reviewItem || reviewItem.organizationId !== params.organizationId) {
    return { ok: false, error: "הפריט לא נמצא." };
  }
  if (reviewItem.status === "resolved") {
    return { ok: false, error: "הפריט כבר טופל." };
  }

  const resolutionText = params.resolutionText.trim();
  if (!resolutionText) return { ok: false, error: "נא לציין תשובה." };

  let policyId: string | null = null;
  if (params.promoteToPolicy) {
    const questionSummary = (params.policyQuestionSummary ?? reviewItem.clientQuestion).trim();
    const decisionText = (params.policyDecisionText ?? resolutionText).trim();
    if (!questionSummary || !decisionText) {
      return { ok: false, error: "נא למלא את פרטי המדיניות לפני השמירה." };
    }
    const [policy] = await db
      .insert(approvedPolicies)
      .values({
        organizationId: params.organizationId,
        questionSummary,
        decisionText,
        category: reviewItem.category,
        sourceReviewItemId: reviewItem.id,
        createdByUserId: params.actorUserId,
      })
      .returning();
    policyId = policy.id;
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "policy.created",
      description: `העובד שמר החלטה כמדיניות: "${questionSummary}"`,
      actorType: "employee",
      actorUserId: params.actorUserId,
      clientId: reviewItem.clientId,
      collectionRequestId: reviewItem.collectionRequestId ?? undefined,
      metadata: { policyId, reviewItemId: reviewItem.id },
    });
  }

  await db
    .update(employeeReviewItems)
    .set({
      status: "resolved",
      resolutionText,
      resolvedByUserId: params.actorUserId,
      resolvedAt: new Date(),
      becamePolicy: params.promoteToPolicy,
      policyId,
    })
    .where(eq(employeeReviewItems.id, reviewItem.id));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "review_item.resolved",
    description: `העובד ענה לפריט בדיקת עובד: "${reviewItem.clientQuestion}"`,
    actorType: "employee",
    actorUserId: params.actorUserId,
    clientId: reviewItem.clientId,
    collectionRequestId: reviewItem.collectionRequestId ?? undefined,
    metadata: { reviewItemId: reviewItem.id, promotedToPolicy: params.promoteToPolicy },
  });

  await sendOutboundMessage(params.organizationId, reviewItem.conversationId, resolutionText, "ai", "manual", undefined, true);

  return { ok: true };
}

export interface ReviewItemContextUpdate {
  note: string;
  clientMessage: string;
  at: string;
}

// The AI-driven counterpart to resolveEmployeeReviewItem — the conversation
// -understanding layer's own high-confidence read that a LATER client
// message unambiguously made an open (or even already-resolved) review
// item moot (found the document another way, changed their mind entirely).
// Never invents a decision: resolutionText here is an internal audit trail
// explaining why the AI believes this is resolved, never the "office
// answer" sent to the client (contrast with resolveEmployeeReviewItem,
// where resolutionText IS the message sent to the client verbatim) — the
// actual client-facing reply is clientAcknowledgment, generated by the
// classifier from the message itself, never inventing new facts.
export async function closeReviewItemFromClientContext(params: {
  organizationId: string;
  reviewItemId: string;
  triggerMessage: string;
  reason: string;
  clientAcknowledgment: string;
}): Promise<ResolveEmployeeReviewItemResult> {
  const db = await getDb();
  const [reviewItem] = await db.select().from(employeeReviewItems).where(eq(employeeReviewItems.id, params.reviewItemId)).limit(1);
  if (!reviewItem || reviewItem.organizationId !== params.organizationId) {
    return { ok: false, error: "הפריט לא נמצא." };
  }
  if (reviewItem.status === "resolved") {
    return { ok: false, error: "הפריט כבר טופל." };
  }

  await db
    .update(employeeReviewItems)
    .set({
      status: "resolved",
      resolutionText: params.reason,
      resolvedBy: "ai_context",
      resolvedByUserId: null,
      resolvedAt: new Date(),
    })
    .where(eq(employeeReviewItems.id, reviewItem.id));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "review_item.auto_resolved_by_context",
    description: `הפריט "${reviewItem.clientQuestion}" נסגר אוטומטית בעקבות הודעת המשך של הלקוח: "${params.triggerMessage}"`,
    actorType: "ai",
    clientId: reviewItem.clientId,
    collectionRequestId: reviewItem.collectionRequestId ?? undefined,
    metadata: { reviewItemId: reviewItem.id, triggerMessage: params.triggerMessage, reason: params.reason },
  });

  await sendOutboundMessage(params.organizationId, reviewItem.conversationId, params.clientAcknowledgment, "ai", "manual", undefined, true);

  return { ok: true };
}

// A softer counterpart to closeReviewItemFromClientContext — the client's
// new message is relevant to an item (open or resolved) but doesn't settle
// it with enough confidence to close it. Purely additive: never rewrites
// clientQuestion/resolutionText, so an employee reviewing the item later
// always sees the original question plus every later update, never a
// silently overwritten record.
export async function addContextNoteToReviewItem(params: {
  organizationId: string;
  reviewItemId: string;
  triggerMessage: string;
  note: string;
  clientAcknowledgment: string;
}): Promise<ResolveEmployeeReviewItemResult> {
  const db = await getDb();
  const [reviewItem] = await db.select().from(employeeReviewItems).where(eq(employeeReviewItems.id, params.reviewItemId)).limit(1);
  if (!reviewItem || reviewItem.organizationId !== params.organizationId) {
    return { ok: false, error: "הפריט לא נמצא." };
  }

  const existingUpdates = (reviewItem.contextUpdates as ReviewItemContextUpdate[] | null) ?? [];
  const newUpdate: ReviewItemContextUpdate = { note: params.note, clientMessage: params.triggerMessage, at: new Date().toISOString() };
  await db
    .update(employeeReviewItems)
    .set({ contextUpdates: [...existingUpdates, newUpdate] })
    .where(eq(employeeReviewItems.id, reviewItem.id));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "review_item.context_updated",
    description: `הלקוח הוסיף מידע רלוונטי לפריט "${reviewItem.clientQuestion}": "${params.triggerMessage}"`,
    actorType: "ai",
    clientId: reviewItem.clientId,
    collectionRequestId: reviewItem.collectionRequestId ?? undefined,
    metadata: { reviewItemId: reviewItem.id, triggerMessage: params.triggerMessage, note: params.note },
  });

  await sendOutboundMessage(params.organizationId, reviewItem.conversationId, params.clientAcknowledgment, "ai", "manual", undefined, true);

  return { ok: true };
}

export async function listPendingEmployeeReviewItems(organizationId: string) {
  const db = await getDb();
  return db
    .select({
      id: employeeReviewItems.id,
      clientId: employeeReviewItems.clientId,
      clientName: clients.name,
      collectionRequestId: employeeReviewItems.collectionRequestId,
      category: employeeReviewItems.category,
      clientQuestion: employeeReviewItems.clientQuestion,
      understoodContext: employeeReviewItems.understoodContext,
      createdAt: employeeReviewItems.createdAt,
    })
    .from(employeeReviewItems)
    .innerJoin(clients, eq(employeeReviewItems.clientId, clients.id))
    .where(and(eq(employeeReviewItems.organizationId, organizationId), eq(employeeReviewItems.status, "pending")))
    .orderBy(desc(employeeReviewItems.createdAt));
}
