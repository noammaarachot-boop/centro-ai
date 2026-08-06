import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequestRequirements, collectionRequests } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { ensureConversation, sendOutboundMessage } from "@/lib/conversationOrchestration";
import { matchTextToCandidates } from "@/lib/ai/documentClassifier";
import { parseRequirementSemantics, type RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";
import { describeRequirement } from "@/lib/requestQnA";
import { checkCompletionGate } from "@/lib/collectionRequestStateMachine";
import { attemptFinishCollectionRequest } from "@/lib/caseReview";

/**
 * "אין לי את המסמך הזה" — a client saying they don't have (or can't get) a
 * required document is never resolved automatically: Centro stops nagging
 * about that specific requirement, opens a clear exception for an office
 * employee to decide on, and never marks the request completed on its own
 * while that exception is still open. See collectionRequestRequirements
 * .exceptionStatus's own schema doc comment for the full state machine.
 */

// How confidently the client's own free-text description of "which
// document" (matchTextToCandidates' Jaccard-style token overlap, 0-1) must
// match an outstanding requirement's name before acting on it without
// asking again — same discipline as every other "never guess" threshold in
// this codebase: below this, a short clarifying question is asked instead.
const MIN_TARGET_MATCH_CONFIDENCE = 0.5;

export type ResolveExceptionTargetOutcome =
  | { kind: "matched"; requirementId: string }
  | { kind: "ambiguous" }
  | { kind: "none_outstanding" };

// Pure matching core — directly unit-testable. `outstanding` is every
// requirement on the request that isn't already satisfied (a client saying
// "I don't have it" about something already received makes no sense to act
// on). Exactly one outstanding requirement is the common case (the client
// is almost always talking about the one thing left) and needs no text
// match at all; with several, the client's own wording is matched against
// each requirement's name.
export function resolveExceptionTarget(
  outstanding: Array<{ id: string; name: string }>,
  mentionedDocumentType: string | null
): ResolveExceptionTargetOutcome {
  if (outstanding.length === 0) return { kind: "none_outstanding" };
  if (outstanding.length === 1) return { kind: "matched", requirementId: outstanding[0].id };
  if (!mentionedDocumentType) return { kind: "ambiguous" };

  const best = matchTextToCandidates(mentionedDocumentType, outstanding);
  if (!best || best.score < MIN_TARGET_MATCH_CONFIDENCE) return { kind: "ambiguous" };
  return { kind: "matched", requirementId: best.id };
}

// Opens the exception: marks the requirement, records the audit trail with
// the client's own literal wording, and acknowledges receipt — never a
// promise of a timeframe, since only the employee can actually decide what
// happens next.
export async function openRequirementException(params: {
  organizationId: string;
  clientId: string;
  conversationId: string;
  collectionRequestId: string;
  requirementId: string;
  clientWording: string;
}): Promise<void> {
  const db = await getDb();
  await db
    .update(collectionRequestRequirements)
    .set({
      exceptionStatus: "reported_missing",
      exceptionNote: params.clientWording,
      exceptionCreatedAt: new Date(),
    })
    .where(eq(collectionRequestRequirements.id, params.requirementId));

  await recordAuditEvent({
    organizationId: params.organizationId,
    eventType: "requirement.exception_reported",
    description: "הלקוח דיווח שאין ברשותו את המסמך הנדרש — נדרשת החלטת עובד",
    actorType: "client",
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    metadata: { requirementId: params.requirementId, clientWording: params.clientWording },
  });

  await sendOutboundMessage(
    params.organizationId,
    params.conversationId,
    "קיבלתי, תודה שעדכנת אותי. אחד מהצוות שלנו יבדוק את זה ויחזור אליך אם צריך.",
    "ai",
    "manual",
    undefined,
    true
  );
}

// When there are several outstanding requirements and the client's wording
// doesn't confidently point at one of them, Centro asks — briefly — rather
// than guessing or opening an exception against the wrong requirement.
export async function askWhichDocumentMissing(params: {
  organizationId: string;
  conversationId: string;
}): Promise<void> {
  await sendOutboundMessage(
    params.organizationId,
    params.conversationId,
    "איזה מסמך בדיוק אין לך? אפשר לציין את השם.",
    "ai",
    "manual",
    undefined,
    true
  );
}

export type RequirementExceptionDecision = "waive" | "request_alternative" | "contact_client" | "leave_open";

export interface ResolveExceptionResult {
  ok: boolean;
  error?: string;
}

// The employee's own decision, applied — the only place that ever changes
// an open exception's outcome. "waive" is the only decision that force-
// satisfies the requirement (computeRequirementSatisfaction's own
// exceptionStatus short-circuit); the other two just suppress automated
// nagging while the office (or a later real document) resolves it another
// way. Re-checks completion immediately after, in case this decision was
// the request's last remaining blocker — matches the "closes the instant
// it's satisfied" principle established for every other completion path.
export async function resolveRequirementException(params: {
  organizationId: string;
  actorUserId?: string;
  requirementId: string;
  decision: RequirementExceptionDecision;
  alternativeText?: string;
}): Promise<ResolveExceptionResult> {
  const db = await getDb();
  const [requirement] = await db
    .select()
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.id, params.requirementId))
    .limit(1);
  if (!requirement) return { ok: false, error: "הדרישה לא נמצאה." };

  const [request] = await db
    .select()
    .from(collectionRequests)
    .where(eq(collectionRequests.id, requirement.collectionRequestId))
    .limit(1);
  if (!request || request.organizationId !== params.organizationId) {
    return { ok: false, error: "בקשת האיסוף לא נמצאה." };
  }

  if (params.decision === "waive") {
    await db
      .update(collectionRequestRequirements)
      .set({ exceptionStatus: "waived" })
      .where(eq(collectionRequestRequirements.id, params.requirementId));
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "requirement.exception_waived",
      description: `העובד ויתר על הדרישה "${requirement.name}" — הבקשה תיחשב ממולאת בלעדיה`,
      actorType: "employee",
      actorUserId: params.actorUserId,
      clientId: request.clientId,
      collectionRequestId: request.id,
      metadata: { requirementId: params.requirementId },
    });
  } else if (params.decision === "request_alternative") {
    const alternativeText = params.alternativeText?.trim();
    if (!alternativeText) return { ok: false, error: "נא לציין את המסמך החלופי המבוקש." };

    const spec = await parseRequirementSemantics(alternativeText, [requirement.name]);
    await db
      .update(collectionRequestRequirements)
      .set({
        name: alternativeText,
        requiredCount: spec.requiredCount,
        semanticSpec: spec as RequirementSemanticSpec,
        exceptionStatus: null,
        exceptionNote: null,
        exceptionCreatedAt: null,
      })
      .where(eq(collectionRequestRequirements.id, params.requirementId));
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "requirement.exception_alternative_requested",
      description: `העובד ביקש מסמך חלופי במקום "${requirement.name}": "${alternativeText}"`,
      actorType: "employee",
      actorUserId: params.actorUserId,
      clientId: request.clientId,
      collectionRequestId: request.id,
      metadata: { requirementId: params.requirementId, alternativeText },
    });

    const conversation = await ensureConversation(params.organizationId, request.id, request.clientId);
    await sendOutboundMessage(
      params.organizationId,
      conversation.id,
      `היי, לגבי המסמך שציינת שאין לך — אפשר לשלוח במקום זאת: ${describeRequirement(alternativeText, spec.requiredCount, spec)}?`,
      "ai",
      "manual",
      undefined,
      true
    );
  } else if (params.decision === "contact_client") {
    await db
      .update(collectionRequestRequirements)
      .set({ exceptionStatus: "will_contact_client" })
      .where(eq(collectionRequestRequirements.id, params.requirementId));
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "requirement.exception_contact_client",
      description: `העובד יצור קשר ידני עם הלקוח לגבי "${requirement.name}"`,
      actorType: "employee",
      actorUserId: params.actorUserId,
      clientId: request.clientId,
      collectionRequestId: request.id,
      metadata: { requirementId: params.requirementId },
    });
  } else {
    await db
      .update(collectionRequestRequirements)
      .set({ exceptionStatus: "left_open" })
      .where(eq(collectionRequestRequirements.id, params.requirementId));
    await recordAuditEvent({
      organizationId: params.organizationId,
      eventType: "requirement.exception_left_open",
      description: `העובד השאיר את "${requirement.name}" פתוח ללא החלטה סופית`,
      actorType: "employee",
      actorUserId: params.actorUserId,
      clientId: request.clientId,
      collectionRequestId: request.id,
      metadata: { requirementId: params.requirementId },
    });
  }

  const gateError = await checkCompletionGate(request.id);
  if (gateError === null) {
    const conversation = await ensureConversation(params.organizationId, request.id, request.clientId);
    await attemptFinishCollectionRequest({
      organizationId: params.organizationId,
      collectionRequestId: request.id,
      conversationId: conversation.id,
      clientId: request.clientId,
      actorType: "employee",
    });
  }

  return { ok: true };
}

// The employee-facing queue — every requirement across the organization
// still awaiting a decision (never one already resolved), with enough
// context (which request, which client — via the caller's own join) to act
// on without navigating away.
export async function listPendingRequirementExceptions(organizationId: string, collectionRequestId?: string) {
  const db = await getDb();
  const rows = await db
    .select({
      requirement: collectionRequestRequirements,
      request: collectionRequests,
    })
    .from(collectionRequestRequirements)
    .innerJoin(collectionRequests, eq(collectionRequestRequirements.collectionRequestId, collectionRequests.id))
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequestRequirements.exceptionStatus, "reported_missing"),
        ...(collectionRequestId ? [eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)] : [])
      )
    );
  return rows;
}
