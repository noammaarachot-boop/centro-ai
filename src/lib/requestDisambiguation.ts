import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  collectionRequests,
  conversations,
  pendingConfirmations,
  pendingRequestDisambiguations,
  services,
} from "@/db/schema";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";

/**
 * Multi-active-collection-request routing — a client can genuinely have
 * two or more collection requests open at once (assigned to two different
 * recurring Services, or a second request opened manually while an
 * earlier one is still waiting on documents). An inbound WhatsApp message
 * carries no signal beyond the sender's phone number, which only ever
 * identifies the CLIENT, never which of their several open requests a
 * given message is about — picking "whichever conversation was most
 * recently updated" would silently guess, and a wrong guess can mark the
 * wrong request's requirement satisfied or auto-complete the wrong
 * request. This module is the disambiguation layer the webhook route
 * (src/app/api/webhooks/whatsapp/route.ts) consults before it ever
 * touches a specific collectionRequestId.
 */

export interface ConversationCandidate {
  conversationId: string;
  collectionRequestId: string;
  status: string;
  periodLabel: string;
  serviceName: string;
}

export type ClientConversationResolution =
  | { outcome: "no_conversation" }
  | { outcome: "resolved"; conversation: typeof conversations.$inferSelect }
  | { outcome: "ambiguous"; candidates: ConversationCandidate[] };

// The single decision point for "which of this client's conversations
// does an inbound message belong to." Preserves the exact previous
// behavior in the only two cases that were ever safe to auto-decide (zero
// conversations; exactly one currently-open one) and only enters real
// disambiguation when two or more are genuinely open at once.
export async function resolveClientConversation(
  organizationId: string,
  clientId: string
): Promise<ClientConversationResolution> {
  const db = await getDb();
  const all = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.clientId, clientId)))
    .orderBy(desc(conversations.updatedAt));

  if (all.length === 0) return { outcome: "no_conversation" };
  if (all.length === 1) return { outcome: "resolved", conversation: all[0] };

  const open = all.filter((c) => c.status !== "closed");
  // Zero or one currently-open conversation: no LIVE ambiguity. Zero-open
  // (every conversation this client has is closed) preserves the original
  // "most recently updated, regardless of status" behavior unchanged —
  // that's the separate, already-scoped post-completion-gate situation,
  // not the active-request ambiguity this module exists to close.
  if (open.length === 0) return { outcome: "resolved", conversation: all[0] };
  if (open.length === 1) return { outcome: "resolved", conversation: open[0] };

  const candidates = await buildCandidates(open);
  return { outcome: "ambiguous", candidates };
}

async function buildCandidates(
  openConversations: Array<typeof conversations.$inferSelect>
): Promise<ConversationCandidate[]> {
  const db = await getDb();
  const candidates: ConversationCandidate[] = [];
  for (const conversation of openConversations) {
    const [row] = await db
      .select({ periodLabel: collectionRequests.periodLabel, serviceName: services.name })
      .from(collectionRequests)
      .innerJoin(services, eq(collectionRequests.serviceId, services.id))
      .where(eq(collectionRequests.id, conversation.collectionRequestId))
      .limit(1);
    candidates.push({
      conversationId: conversation.id,
      collectionRequestId: conversation.collectionRequestId,
      status: conversation.status,
      periodLabel: row?.periodLabel ?? "",
      serviceName: row?.serviceName ?? "",
    });
  }
  return candidates;
}

// Tier 2 — the one unambiguous signal this module currently acts on
// automatically: if exactly one of the client's open requests is actually
// waiting on THEM for an answer (a pending_confirmations row still
// unresolved) and the others aren't, a reply naturally belongs to the one
// that asked. Deliberately conservative — this does not attempt
// content-based document classification across candidates (that would
// require downloading and classifying media before routing at all,
// touching the intake pipeline's own ordering); a document with no open
// question anywhere, or open questions on more than one candidate, is not
// resolved here and falls through to Tier 3 (ask).
export async function tryUnambiguousMatchByOpenQuestion(
  candidates: ConversationCandidate[]
): Promise<ConversationCandidate | null> {
  const db = await getDb();
  const withOpenQuestion: ConversationCandidate[] = [];
  for (const candidate of candidates) {
    const [row] = await db
      .select({ id: pendingConfirmations.id })
      .from(pendingConfirmations)
      .where(
        and(
          eq(pendingConfirmations.conversationId, candidate.conversationId),
          eq(pendingConfirmations.status, "pending")
        )
      )
      .limit(1);
    if (row) withOpenQuestion.push(candidate);
  }
  return withOpenQuestion.length === 1 ? withOpenQuestion[0] : null;
}

// Used ONLY when an open disambiguation already exists but the current
// message doesn't resolve as an answer to it (see route.ts) — picks the
// client's most recently active open conversation as this one turn's
// target, without creating a second disambiguation (which would violate
// the one-open-per-client partial unique index) and without touching the
// existing pending disambiguation at all, so a later numbered/ordinal/
// named reply can still resolve it exactly as before. Mirrors
// resolveClientConversation's own "most recently updated" fallback
// ordering (never guesses a *different* rule for this closely related
// situation) — the difference here is only that this is used to bypass a
// stale, unresolved question for one turn, not to route a message that
// never had an open disambiguation at all.
export async function mostRecentlyActiveOpenConversation(
  organizationId: string,
  clientId: string
): Promise<typeof conversations.$inferSelect | null> {
  const db = await getDb();
  const all = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.organizationId, organizationId), eq(conversations.clientId, clientId)))
    .orderBy(desc(conversations.updatedAt));
  if (all.length === 0) return null;
  const open = all.filter((c) => c.status !== "closed");
  return open[0] ?? all[0];
}

export async function findOpenDisambiguationForClient(organizationId: string, clientId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(pendingRequestDisambiguations)
    .where(
      and(
        eq(pendingRequestDisambiguations.organizationId, organizationId),
        eq(pendingRequestDisambiguations.clientId, clientId),
        isNull(pendingRequestDisambiguations.resolvedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

function formatClarificationQuestion(candidates: ConversationCandidate[]): string {
  const lines = candidates.map((c, i) => `${i + 1}. ${c.serviceName} — ${c.periodLabel}`);
  return `יש לך כמה בקשות איסוף מסמכים פתוחות במקביל. לאיזו מהן מתייחסת ההודעה האחרונה ששלחת?\n\n${lines.join("\n")}\n\nהשיבו במספר המתאים.`;
}

// Tier 3 — holds the real content (never attached to any collectionRequestId
// yet, since we don't know which one it belongs to) and asks the client
// directly. Nothing about any candidate request is touched by this call.
export async function createRequestDisambiguation(params: {
  organizationId: string;
  clientId: string;
  candidates: ConversationCandidate[];
  messageBody: string | null;
  attachment: { fileName: string; mimeType: string; content: Buffer } | null;
  whatsappMessageId: string | null;
}): Promise<void> {
  const db = await getDb();
  // Any candidate works as the technical carrier for logging the
  // clarification question itself — it never implies that request is the
  // answer. Sending through it does bump that one conversation's own
  // updatedAt (sendOutboundMessage does this for every send, the same
  // message-delivery bookkeeping any real outbound message causes) — that
  // resets its own staleness/reminder clock, but touches no document, no
  // requirement, no completion state, and implies nothing about which
  // candidate the client actually meant.
  const hostConversationId = params.candidates[0].conversationId;

  const [row] = await db
    .insert(pendingRequestDisambiguations)
    .values({
      organizationId: params.organizationId,
      clientId: params.clientId,
      candidateCollectionRequestIds: params.candidates.map((c) => c.collectionRequestId),
      hostConversationId,
      messageBody: params.messageBody,
      pendingFileName: params.attachment?.fileName ?? null,
      pendingFileContent: params.attachment?.content ?? null,
      pendingFileMimeType: params.attachment?.mimeType ?? null,
      whatsappMessageId: params.whatsappMessageId,
    })
    .returning();

  await sendOutboundMessage(
    params.organizationId,
    hostConversationId,
    formatClarificationQuestion(params.candidates),
    "ai",
    "manual",
    undefined,
    true
  );

  console.log("[request-disambiguation] question sent — held, no collection request touched", {
    organizationId: params.organizationId,
    clientId: params.clientId,
    disambiguationId: row.id,
    candidateCount: params.candidates.length,
  });
}

// Re-derives fresh, current period labels/service names rather than
// trusting anything cached on the row — cheap, and avoids ever showing a
// stale label if a redelivery or a slow reply causes this to be resent.
async function currentCandidates(candidateCollectionRequestIds: string[]): Promise<ConversationCandidate[]> {
  const db = await getDb();
  const candidates: ConversationCandidate[] = [];
  for (const collectionRequestId of candidateCollectionRequestIds) {
    const [row] = await db
      .select({
        conversationId: conversations.id,
        status: conversations.status,
        periodLabel: collectionRequests.periodLabel,
        serviceName: services.name,
      })
      .from(collectionRequests)
      .innerJoin(services, eq(collectionRequests.serviceId, services.id))
      .innerJoin(conversations, eq(conversations.collectionRequestId, collectionRequests.id))
      .where(eq(collectionRequests.id, collectionRequestId))
      .limit(1);
    if (row) {
      candidates.push({
        conversationId: row.conversationId,
        collectionRequestId,
        status: row.status,
        periodLabel: row.periodLabel,
        serviceName: row.serviceName,
      });
    }
  }
  return candidates;
}

export async function resendDisambiguationClarification(
  row: typeof pendingRequestDisambiguations.$inferSelect
): Promise<void> {
  const candidates = await currentCandidates(row.candidateCollectionRequestIds);
  if (candidates.length === 0) return; // every candidate vanished (e.g. cancelled) — nothing left to ask about
  await sendOutboundMessage(
    row.organizationId,
    row.hostConversationId,
    formatClarificationQuestion(candidates),
    "ai",
    "manual",
    undefined,
    true
  );
}

export interface DisambiguationResolution {
  collectionRequestId: string;
  messageBody: string | null;
  fileName: string | null;
  pendingFileContent: Buffer | null;
  pendingFileMimeType: string | null;
  whatsappMessageId: string | null;
}

// Hebrew ordinal words accepted alongside a literal digit as an equally
// unambiguous choice ("הראשונה" == "1"). Deliberately a small, closed list
// — not general NLP — matching this module's own "never guess" discipline:
// anything not a digit, not on this list, and not an exact single-candidate
// name match resolves to null, same as an unparseable reply always has.
const ORDINAL_WORDS: Record<string, number> = {
  "ראשון": 1, "ראשונה": 1, "הראשון": 1, "הראשונה": 1,
  "שני": 2, "שנייה": 2, "השני": 2, "השנייה": 2,
  "שלישי": 3, "שלישית": 3, "השלישי": 3, "השלישית": 3,
  "רביעי": 4, "רביעית": 4, "הרביעי": 4, "הרביעית": 4,
  "חמישי": 5, "חמישית": 5, "החמישי": 5, "החמישית": 5,
};

// Resolves a reply against the REAL, CURRENT candidate list (never the
// stale one on the row) — a digit ("2"), an ordinal word ("השנייה"), or
// text that names exactly one candidate's own periodLabel unambiguously.
// Returns the 1-based index into `candidates`, or null when nothing
// resolves to exactly one candidate — callers must never guess among ties
// (two distinct numbers, an ordinal AND a different number, or text that
// matches more than one candidate's label all resolve to null, same as an
// unparseable reply always has).
function parseDisambiguationChoice(candidates: ConversationCandidate[], replyText: string): number | null {
  const trimmed = replyText.trim();
  if (!trimmed) return null;

  // A standalone digit only — never one embedded in a larger alphanumeric
  // word (e.g. the "2" inside a candidate's own name like "בדיקת V2" must
  // never be misread as "the user picked option 2").
  const numbers = [...trimmed.matchAll(/(?<![A-Za-zא-ת0-9])\d+(?![A-Za-zא-ת0-9])/g)].map((m) => Number.parseInt(m[0], 10));
  const numericChoices = [...new Set(numbers)].filter((n) => n >= 1 && n <= candidates.length);
  if (numericChoices.length === 1) return numericChoices[0];
  if (numericChoices.length > 1) return null; // more than one distinct number named — don't guess

  const words = trimmed.split(/\s+/);
  const ordinalChoices = [
    ...new Set(words.map((w) => ORDINAL_WORDS[w]).filter((n): n is number => !!n && n <= candidates.length)),
  ];
  if (ordinalChoices.length === 1) return ordinalChoices[0];
  if (ordinalChoices.length > 1) return null; // named more than one distinct ordinal — don't guess

  // Name match — the part of periodLabel before " — " (its own natural
  // discriminator, e.g. "בדיקת V2" out of "בדיקת V2 — אוגוסט 2026") must
  // appear verbatim in the reply, and in exactly one candidate's label —
  // never a generic/shared word (e.g. a shared serviceName, or the month
  // both labels happen to share) that would match more than one.
  const nameMatches = candidates
    .map((c, i) => ({ index: i + 1, label: (c.periodLabel.split("—")[0] ?? c.periodLabel).trim() }))
    .filter((c) => c.label.length >= 2 && trimmed.includes(c.label));
  if (nameMatches.length === 1) return nameMatches[0].index;

  return null;
}

// Parses the client's reply as a choice among the exact candidates the
// question was actually sent with, re-derived fresh (never trusting a
// stale label on the row — same discipline as resendDisambiguationClarification).
// Returns null (never throws, never picks a default) when the reply
// doesn't unambiguously pick exactly one option — the caller decides what
// to do next (re-ask, or fall through to normal understanding) instead of
// this function ever guessing.
export async function resolveDisambiguationReply(
  row: typeof pendingRequestDisambiguations.$inferSelect,
  replyText: string
): Promise<DisambiguationResolution | null> {
  const candidates = await currentCandidates(row.candidateCollectionRequestIds);
  const choice = parseDisambiguationChoice(candidates, replyText);
  if (choice === null) return null;

  // Indexed into `candidates` (the freshly re-fetched, possibly-shorter
  // list — see currentCandidates' own doc comment), never back into the
  // row's original candidateCollectionRequestIds — a vanished candidate
  // in between would otherwise silently shift every later index.
  const collectionRequestId = candidates[choice - 1].collectionRequestId;

  const db = await getDb();
  // Atomic claim — the same compare-and-swap discipline used throughout
  // this codebase's other pending-confirmation resolvers: two concurrent
  // webhook redeliveries racing to resolve the same open question must
  // never both replay the held content.
  const claimed = await db
    .update(pendingRequestDisambiguations)
    .set({ resolvedAt: new Date(), resolvedCollectionRequestId: collectionRequestId })
    .where(and(eq(pendingRequestDisambiguations.id, row.id), isNull(pendingRequestDisambiguations.resolvedAt)))
    .returning();
  if (claimed.length === 0) return null; // another concurrent attempt already resolved this

  return {
    collectionRequestId,
    messageBody: row.messageBody,
    fileName: row.pendingFileName,
    pendingFileContent: row.pendingFileContent,
    pendingFileMimeType: row.pendingFileMimeType,
    whatsappMessageId: row.whatsappMessageId,
  };
}
