import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { pendingConfirmations } from "@/db/schema";
import { ensureConversation, sendOutboundMessage } from "@/lib/conversationOrchestration";

/**
 * Milestone 5 — Architecture Ch.3's "Confirm with the client, through
 * WhatsApp" step, as reusable infrastructure. Nothing in this module knows
 * about documents, business types, or any other domain — a caller (this
 * milestone's own manual trigger on the collection request page;
 * Milestone 6's automatic pattern-detection later) supplies a `kind`, a
 * `payload`, and the exact question text, and this module handles sending
 * it, tracking it, and resolving a reply. What happens when a
 * confirmation resolves is entirely the caller's responsibility — this
 * module only ever reports the outcome.
 */

export type PendingConfirmationKind = "document_profile_addition" | "document_profile_removal";

export interface PendingConfirmationPayload {
  [key: string]: unknown;
}

// Suggest step: sends the question over the (mocked) WhatsApp transport
// and records exactly one row — never asked twice for the same thing, so
// callers should check listOpenConfirmationsForCollectionRequest first if
// there's any risk of asking about the same fact repeatedly.
export async function createPendingConfirmation(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  kind: PendingConfirmationKind;
  payload: PendingConfirmationPayload;
  question: string;
}) {
  const conversation = await ensureConversation(
    params.organizationId,
    params.collectionRequestId,
    params.clientId
  );

  await sendOutboundMessage(params.organizationId, conversation.id, params.question, "ai");

  const db = await getDb();
  const [row] = await db
    .insert(pendingConfirmations)
    .values({
      organizationId: params.organizationId,
      clientId: params.clientId,
      collectionRequestId: params.collectionRequestId,
      conversationId: conversation.id,
      kind: params.kind,
      payload: params.payload,
      question: params.question,
    })
    .returning();

  return row;
}

export async function listOpenConfirmationsForCollectionRequest(collectionRequestId: string) {
  const db = await getDb();
  return db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, collectionRequestId),
        eq(pendingConfirmations.status, "pending")
      )
    );
}

// Milestone 4-style unified exceptions surface — every organization-wide
// open confirmation, for the dashboard's own queue card.
export async function listOpenConfirmations(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.organizationId, organizationId),
        eq(pendingConfirmations.status, "pending")
      )
    );
}

async function resolve(
  organizationId: string,
  id: string,
  confirmed: boolean,
  responseText: string | null
) {
  const db = await getDb();
  const [row] = await db
    .update(pendingConfirmations)
    .set({
      status: confirmed ? "confirmed" : "declined",
      responseText,
      respondedAt: new Date(),
    })
    .where(
      and(
        eq(pendingConfirmations.id, id),
        eq(pendingConfirmations.organizationId, organizationId),
        eq(pendingConfirmations.status, "pending")
      )
    )
    .returning();
  return row ?? null;
}

// The employee-facing quick-action equivalent of markFinished/
// markMoreDocuments — a direct override, used regardless of whether a
// real client reply ever arrives (WhatsApp is still mocked project-wide).
// Scoped by organizationId — this id is a caller-supplied form value, not
// something the caller has already verified belongs to their org (unlike
// collectionRequestId, which the caller resolves via a scoped lookup
// first), so the update itself must enforce the tenant boundary.
export async function respondToPendingConfirmationManually(
  organizationId: string,
  id: string,
  confirmed: boolean
) {
  return resolve(organizationId, id, confirmed, null);
}

const YES_WORDS = ["כן", "אישור", "מאשר", "מאשרת", "בטח", "בסדר", "אוקיי", "yes", "ok"];
const NO_WORDS = ["לא", "לא צריך", "לא רוצה", "בטל", "no"];

// Deterministic, same mock-first pattern as intentClassifier.ts — no LLM
// provider is configured for this pilot. A free-text reply only counts as
// a clear answer when it *leads with* a yes/no word (exactly that word,
// or that word followed by more text) — never when the word merely
// appears somewhere inside a longer, more ambiguous sentence. Without
// this, a substring check alone would misread "אני לא בטוח" ("I'm not
// sure" — which does contain "לא", "no") as a confident "no", exactly
// the kind of guess Ch.1 rules out. Anything that doesn't clearly lead
// with either is "unclear" and left for a human to resolve manually.
function leadsWithAny(trimmed: string, words: string[]): boolean {
  return words.some(
    (w) => trimmed === w || trimmed.startsWith(`${w} `) || trimmed.startsWith(`${w},`)
  );
}

export function parseConfirmationReply(text: string): "yes" | "no" | "unclear" {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return "unclear";
  if (leadsWithAny(trimmed, NO_WORDS)) return "no";
  if (leadsWithAny(trimmed, YES_WORDS)) return "yes";
  return "unclear";
}

// Called on every inbound message for a conversation — a no-op (returns
// null) unless there is actually an open confirmation waiting for this
// exact conversation. Never guesses: an "unclear" reply leaves the
// confirmation pending for a human to resolve via
// respondToPendingConfirmationManually instead of being silently
// misread as a yes or no.
export async function resolveConfirmationFromReply(conversationId: string, replyText: string) {
  const db = await getDb();
  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(eq(pendingConfirmations.conversationId, conversationId), eq(pendingConfirmations.status, "pending"))
    )
    .limit(2); // only need to know "one" vs "more than one"

  // A free-text reply can only be auto-resolved when it's unambiguous
  // which question it's answering — exactly one open confirmation on this
  // conversation. Milestone 6 can legitimately open two at once (an
  // addition suggestion mid-cycle, a removal suggestion at completion);
  // with more than one open, guessing which the client meant would be
  // exactly the kind of guess Ch.1 rules out — left for a human to
  // resolve explicitly instead (respondToPendingConfirmationManually,
  // which targets one specific confirmation by id).
  if (openRows.length !== 1) return null;
  const open = openRows[0];

  const intent = parseConfirmationReply(replyText);
  if (intent === "unclear") return null;

  return resolve(open.organizationId, open.id, intent === "yes", replyText);
}
