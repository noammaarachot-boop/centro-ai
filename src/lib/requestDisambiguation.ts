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

// Parses the client's reply as a choice among the exact candidates the
// question was actually sent with (never re-derives them by content
// matching — a number is the only signal this accepts, so there is
// nothing here to guess). Returns null (never throws, never picks a
// default) when the reply doesn't unambiguously pick exactly one option —
// the caller re-asks instead of proceeding.
export async function resolveDisambiguationReply(
  row: typeof pendingRequestDisambiguations.$inferSelect,
  replyText: string
): Promise<DisambiguationResolution | null> {
  const candidateIds = row.candidateCollectionRequestIds;
  const numbers = [...replyText.matchAll(/\d+/g)].map((m) => Number.parseInt(m[0], 10));
  const uniqueChoices = [...new Set(numbers)].filter((n) => n >= 1 && n <= candidateIds.length);
  if (uniqueChoices.length !== 1) return null; // no number, or more than one distinct choice — ambiguous, don't guess

  const collectionRequestId = candidateIds[uniqueChoices[0] - 1];

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
