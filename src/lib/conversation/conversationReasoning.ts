/**
 * Phase 1 scaffolding for the conversation-intelligence redesign (2026-08).
 * Type contracts only — nothing in this file is consumed by production
 * logic yet. classifyConversationIntent/conversationDispatch.ts keep
 * running exactly as they do today; these types exist so Phase 2
 * (reference/focus resolution) and Phase 3 (the ACT/ANSWER/CLARIFY/
 * ESCALATE/UNRELATED restructure) have a settled contract to build
 * against, instead of inventing shapes ad hoc mid-implementation.
 */

// Confirmed durable focus — mirrors client_conversation_focus exactly.
// Authoritative BY CONSTRUCTION: every source value here names an explicit,
// unambiguous signal. An LLM's own hypothesis about which request a message
// concerns is never one of these — see ResolvedReference below, which is
// deliberately a *different*, non-authoritative type.
export type ConfirmedFocusSource = "single_open_request" | "disambiguation_reply" | "explicit_switch";

export interface ConfirmedFocus {
  collectionRequestId: string;
  source: ConfirmedFocusSource;
  setAt: string;
}

// A real, current DB row the current turn's reference resolution (Phase 2)
// can point "it" / "the first one" / "that" / "the second" at. Built fresh
// every turn from live data — never from parsing the system's own past
// outbound text, and never persisted as a list anywhere.
export type DiscourseEntityKind = "collection_request" | "document" | "requirement" | "review_item";

export interface DiscourseEntity {
  kind: DiscourseEntityKind;
  id: string;
  label: string;
}

// Where a resolved reference's meaning actually came from — lets Phase 3+
// tell "the message itself named this" apart from "the model guessed from
// soft context," without parsing free text. Never itself written anywhere;
// only "message_explicit" (or a resolver-external explicit signal, like a
// numbered disambiguation reply) is ever a legitimate basis for writing
// ConfirmedFocus — see confirmDurableFocus in referenceResolution.ts.
export type ReferenceProvenance =
  | "confirmed_focus" // durable focus applied as-is; nothing in the message overrode it
  | "message_explicit" // the current message itself names/switches to this referent
  | "context_inferred"; // softer inference from recent conversation only — weakest, never durable

// The result of resolving what the current message's pronouns/ordinals
// refer to. Ephemeral — scoped to this one turn, never written to DB as
// fact. A caller MUST re-validate `id` against a real, current row before
// any mutation ever touches it — the exact discipline correctionTargetId
// already requires today (conversationIntent.ts: "לעולם אל תמציאי id").
// This is explicitly NOT a ConfirmedFocus: resolving a reference, even with
// high confidence, never by itself promotes anything to durable/
// authoritative state (see client_conversation_focus's own doc comment).
export interface ResolvedReference {
  kind: DiscourseEntityKind;
  id: string;
  confidence: number;
  provenance: ReferenceProvenance;
  // Short internal explanation for audit/observability — never shown to
  // the client verbatim, mirrors reviewItemReason's existing role.
  basis: string;
}

// Typed action contracts — one per existing deterministic handler
// (conversationDispatch.ts). The reasoning layer may only ever PROPOSE one
// of these; a trusted, validating handler is what actually mutates the DB
// (Phase 4). Not a new taxonomy — today's action-triggering
// ConversationIntentKind values (resolves_pending, corrects_resolved,
// reports_missing_document, finished_signal, deferral_promise,
// resolves_review_item), made explicit and typed.
export type ActionContract =
  | { kind: "resolve_pending"; openQuestionId: string; answer: "confirm" | "decline" }
  | { kind: "resolve_clarification"; openQuestionId: string; replyText: string }
  | {
      kind: "correct_resolved";
      targetType: "document" | "confirmation";
      targetId: string;
      desiredOutcome: "attach_to_requirement" | "save_as_extra" | "mark_withdrawn";
    }
  | { kind: "report_missing_document"; mentionedType: string | null }
  | { kind: "finish_request" }
  | { kind: "defer"; replyText: string }
  | {
      kind: "resolve_review_item";
      reviewItemId: string;
      action: "close_resolved" | "add_context_note";
      reason: string;
      acknowledgment: string;
    };

// The five general reasoning outcomes (Phase 3) — outcomes of reasoning,
// not an intent taxonomy in disguise. ANSWER/CLARIFY/ESCALATE carry no
// fixed category enum: ANSWER's `text` is LLM-composed from `groundedOn`
// facts only (never invented); ESCALATE is a last resort, not a default for
// "no matching category" (see conversationDispatch.ts's current
// needs_employee_review handling, which this generalizes).
export type ReasoningOutcome =
  // confidence gates execution per action sub-kind (actionExecution.ts) —
  // the same MIN_ACT_CONFIDENCE/REVIEW_ITEM_*_CONFIDENCE discipline
  // conversationDispatch.ts already applies today, filled in here (Phase 1
  // shipped this variant without it — completing the contract now that
  // Phase 3 actually builds against it, same kind of small evolution
  // Phase 2 made to ResolvedReference by adding `provenance`).
  | { kind: "ACT"; action: ActionContract; confidence: number }
  | { kind: "ANSWER"; text: string; groundedOn: string[] }
  | { kind: "CLARIFY"; question: string; missing: string }
  // Same 3-value set handlePotentialReviewQuestion's own ReviewCategory
  // accepts (employeeReview.ts) — "missing_document" is deliberately
  // excluded here, since ACT's own report_missing_document action kind
  // already covers that case; ESCALATE never needs it.
  | { kind: "ESCALATE"; category: "alternative_or_policy_question" | "human_request" | "other"; gist: string }
  | { kind: "UNRELATED" }
  // Phase 4 — deliberately distinct from UNRELATED. UNRELATED means the
  // model looked at the message and genuinely decided it's not about this
  // case; REASONING_FAILED means the reasoning call itself never produced
  // a real decision (provider error, timeout, malformed response) — the
  // system never "understood" anything here. Collapsing the two into one
  // value (as reasonAboutMessage's catch block did before Phase 4) hides
  // real AI-layer outages behind what looks like a normal, confident
  // decision. Never routed to legacy — see understandConversationTurn's own
  // doc comment for why a second AI call provides no real resilience here.
  | { kind: "REASONING_FAILED"; reason: string };
