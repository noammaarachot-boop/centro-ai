import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, pendingConfirmations } from "@/db/schema";
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
 *
 * Smart notification grouping (flushDueIntakeNotifications below) adds a
 * second sending mode: a "batched" confirmation (notifyAfter set at
 * creation) is held rather than sent immediately, so several documents/
 * anomalies arriving in a short burst reach the client as one combined
 * message instead of one per file. Still domain-agnostic — a caller's
 * `question` is just the descriptive statement; this module decides when
 * to send it and, in the batched case, appends the numbered yes/no options
 * itself once a row's final position in the combined message (groupIndex)
 * is known.
 */

export type PendingConfirmationKind =
  | "document_profile_addition"
  | "document_profile_removal"
  // Ch.6 3-way document intake split (src/lib/documentIntakeReview.ts) —
  // "unsolicited_document": the AI identified the document with real
  // confidence but it doesn't answer any open requirement; a yes/no
  // question ("did you mean to send this?"), resolved the same way as the
  // two kinds above. "document_clarification": the AI couldn't identify
  // the document at all; an open-ended question, resolved by whatever the
  // client actually writes back — see resolveOpenClarificationReply below,
  // not the generic yes/no resolveConfirmationFromReply.
  | "unsolicited_document"
  | "document_clarification"
  // Smart identity/consistency verification (documentIdentityVerification.ts)
  // — the document's own content doesn't line up with the client or a
  // sibling document already received (wrong person's name/ID, mismatched
  // ID between two documents, wrong company). Yes/no, resolved the same
  // way as unsolicited_document.
  | "identity_anomaly";

// The two kinds smart notification grouping ever batches — both are
// yes/no questions about a specific document (or several), always with the
// exact same two reply options (see formatGroupOptions). document_profile_*
// and document_clarification are never batched: the former predates
// grouping and was never reported as flooding anyone, the latter is
// open-ended free text with no numbered options to assign a groupIndex to.
const BATCHABLE_KINDS: PendingConfirmationKind[] = ["unsolicited_document", "identity_anomaly"];

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
  // Opt-in reminder scheduling — the document-intake kinds use this
  // (src/lib/documentIntakeReview.ts); the two document_profile_* kinds
  // don't pass it and keep their original never-reminded behavior. Ignored
  // in batched mode (notifyAfter set) — the reminder countdown only starts
  // once the question is actually sent, at flush time.
  reminderIntervalDays?: number;
  // Passed straight through to sendOutboundMessage — see its own doc
  // comments for what each means. Both default to the original behavior
  // (automated + template-only) so the two document_profile_* callers,
  // which don't pass these, are unaffected by this fix. Ignored in batched
  // mode — flushDueIntakeNotifications always sends manual + allowFreeform.
  trigger?: "manual" | "automated";
  allowFreeform?: boolean;
  // Smart notification grouping — when set, this row is held (never sent
  // immediately) until flushDueIntakeNotifications actually dispatches it,
  // combined with every other still-unnotified row on the same collection
  // request. Omit for every kind that isn't unsolicited_document/
  // identity_anomaly — those keep sending immediately exactly as before.
  notifyAfter?: Date;
}) {
  const conversation = await ensureConversation(
    params.organizationId,
    params.collectionRequestId,
    params.clientId
  );

  const db = await getDb();

  if (params.notifyAfter) {
    console.log("[pending-confirmation] created in batched mode, holding for grouping window", {
      kind: params.kind,
      collectionRequestId: params.collectionRequestId,
      notifyAfter: params.notifyAfter.toISOString(),
    });
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
        notifyAfter: params.notifyAfter,
      })
      .returning();
    return row;
  }

  console.log("[pending-confirmation] send attempted", {
    kind: params.kind,
    collectionRequestId: params.collectionRequestId,
    conversationId: conversation.id,
    trigger: params.trigger ?? "automated",
    allowFreeform: params.allowFreeform ?? false,
  });
  const { sent } = await sendOutboundMessage(
    params.organizationId,
    conversation.id,
    params.question,
    "ai",
    params.trigger ?? "automated",
    undefined,
    params.allowFreeform ?? false
  );
  console.log("[pending-confirmation] send result", {
    kind: params.kind,
    collectionRequestId: params.collectionRequestId,
    // `sent` reflects only the automation gate (see sendOutboundMessage's
    // own doc comment) — real delivery success/failure is logged
    // separately by sendOutboundMessage itself
    // (document_collection_send_accepted / _failed) with the actual
    // whatsappMessageId or deliveryStatus.
    gatedSent: sent,
  });

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
      nextReminderAt: params.reminderIntervalDays
        ? new Date(Date.now() + params.reminderIntervalDays * 24 * 60 * 60 * 1000)
        : null,
    })
    .returning();

  return row;
}

// The two numbered reply options every batched (unsolicited_document /
// identity_anomaly) question uses — identical wording regardless of kind,
// which is what lets flushDueIntakeNotifications combine rows of different
// kinds into one message with one shared numbering scheme. Group i's
// options are always 2*i+1 (yes) and 2*i+2 (no).
const YES_OPTION_LABEL = "כן, שלחתי בכוונה";
const NO_OPTION_LABEL = "לא, שלחתי בטעות";

function formatGroupOptions(groupIndex: number): string {
  return `${groupIndex * 2 + 1}. ${YES_OPTION_LABEL}\n${groupIndex * 2 + 2}. ${NO_OPTION_LABEL}`;
}

// Reused by the reminder resend (documentIntakeReview.ts's
// sendConfirmationRemindersAndEscalate) so a resent question still carries
// the same numbered options the original combined message did.
export function formatQuestionWithOptions(question: string, groupIndex: number | null): string {
  return `${question}\n${formatGroupOptions(groupIndex ?? 0)}`;
}

export interface FlushResult {
  sent: boolean;
  groupCount: number;
}

// The other half of smart notification grouping: called after any new
// batched row might have been created/merged on a collection request
// (processInboundAttachment) and once per organization per cron tick
// (scheduler.ts) — a no-op unless at least one still-unnotified batched row
// on this request has actually crossed its notifyAfter deadline. When one
// has, EVERY still-unnotified batched row on the request is sent together
// in one message, not just the row that became due — a second anomaly that
// arrived a few seconds after the first, still well within its own window,
// is folded into the same send rather than triggering a second message
// moments later.
export async function flushDueIntakeNotifications(
  organizationId: string,
  collectionRequestId: string
): Promise<FlushResult> {
  const db = await getDb();
  const pending = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(
        eq(pendingConfirmations.collectionRequestId, collectionRequestId),
        eq(pendingConfirmations.status, "pending"),
        isNull(pendingConfirmations.notifiedAt)
      )
    );

  const batchable = pending.filter((row) => BATCHABLE_KINDS.includes(row.kind as PendingConfirmationKind));
  if (batchable.length === 0) return { sent: false, groupCount: 0 };

  const now = new Date();
  const isDue = batchable.some((row) => row.notifyAfter && row.notifyAfter <= now);
  if (!isDue) return { sent: false, groupCount: 0 };

  const ordered = [...batchable].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const [org] = await db
    .select({ reminderIntervalDays: organizations.reminderIntervalDays })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const reminderIntervalDays = org?.reminderIntervalDays ?? 2;

  // A single group needs no preamble or section numbering — the common
  // case (one document, one anomaly) reads exactly like a standalone
  // question, unchanged from before grouping existed.
  const messageBody =
    ordered.length === 1
      ? formatQuestionWithOptions(ordered[0].question, 0)
      : [
          "קיבלנו את המסמכים הבאים:",
          "",
          ...ordered.map((row, i) => `${i + 1}. ${formatQuestionWithOptions(row.question, i)}`),
        ].join("\n\n");

  console.log("[pending-confirmation] flushing batched intake notification", {
    organizationId,
    collectionRequestId,
    groupCount: ordered.length,
    kinds: ordered.map((row) => row.kind),
  });

  const { sent } = await sendOutboundMessage(
    organizationId,
    ordered[0].conversationId,
    messageBody,
    "ai",
    "manual",
    undefined,
    true
  );
  console.log("[pending-confirmation] batched send result", {
    collectionRequestId,
    gatedSent: sent,
  });

  for (const [index, row] of ordered.entries()) {
    await db
      .update(pendingConfirmations)
      .set({
        groupIndex: index,
        notifiedAt: now,
        nextReminderAt: new Date(now.getTime() + reminderIntervalDays * 24 * 60 * 60 * 1000),
      })
      .where(eq(pendingConfirmations.id, row.id));
  }

  return { sent: true, groupCount: ordered.length };
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

type ResolvedRow = NonNullable<Awaited<ReturnType<typeof resolve>>>;

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

// "1"/"2" cover the numbered-option format the document-intake questions
// use (e.g. "1. כן, שלחתי בכוונה" / "2. לא, שלחתי בטעות") — a bare digit
// reply is unambiguous there. True WhatsApp interactive reply buttons
// would remove any need for free-text parsing at all; not implemented in
// this pass (still plain text, per every other outbound message in this
// codebase), tracked as a follow-up.
const YES_WORDS = ["כן", "אישור", "מאשר", "מאשרת", "בטח", "בסדר", "אוקיי", "yes", "ok", "1"];
const NO_WORDS = ["לא", "לא צריך", "לא רוצה", "בטל", "no", "2"];

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
//
// Only ever resolves when there's exactly one open (non-clarification)
// confirmation — with two or more open at once (a grouped batch), which
// one a bare "כן"/"לא" answers is genuinely ambiguous; see
// resolveBatchedIntakeReply below, which callers check first and which
// requires the client to answer by number instead of guessing.
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
  // document_clarification is open-ended ("what document is this?"), not
  // yes/no — routed exclusively through resolveOpenClarificationReply
  // below. Without this exclusion, a clarification reply that happens to
  // start with a NO_WORD (e.g. "לא יודע בדיוק, נראה כמו קבלה" — "not sure
  // exactly, looks like a receipt") would be misread as declining
  // something there was never a yes/no question about.
  if (open.kind === ("document_clarification" satisfies PendingConfirmationKind)) return null;

  const intent = parseConfirmationReply(replyText);
  if (intent === "unclear") return null;

  return resolve(open.organizationId, open.id, intent === "yes", replyText);
}

// The document_clarification counterpart to resolveConfirmationFromReply —
// open-ended, not yes/no: any non-empty reply counts as an answer (the
// client's own words are the classification input, handled by
// applyClarificationReply in src/lib/documentIntakeReview.ts), never
// parsed for intent here. Same "exactly one open confirmation, else don't
// guess" discipline, scoped to this one kind.
export async function resolveOpenClarificationReply(conversationId: string, replyText: string) {
  const trimmed = replyText.trim();
  if (!trimmed) return null;

  const db = await getDb();
  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(eq(pendingConfirmations.conversationId, conversationId), eq(pendingConfirmations.status, "pending"))
    )
    .limit(2);
  if (openRows.length !== 1) return null;
  const open = openRows[0];
  if (open.kind !== ("document_clarification" satisfies PendingConfirmationKind)) return null;

  return resolve(open.organizationId, open.id, true, replyText);
}

// Smart notification grouping's reply counterpart: once a combined message
// with several numbered groups has actually gone out (every open row here
// carries a real groupIndex — see flushDueIntakeNotifications), the client
// answers by number instead of a bare "כן"/"לא", e.g. "1" or "1,4" or
// "1 ו-3". Each number maps to exactly one group (odd = confirmed, even =
// declined; group i's options are 2*i+1/2*i+2) and is resolved
// independently — answering group 1 never touches group 2's own open
// question. A reply with no parseable number resolves nothing here (no
// guess), leaving every group open until the client either sends a number
// or — once only one group is left open — a plain "כן"/"לא" that
// resolveConfirmationFromReply above can unambiguously apply.
export async function resolveBatchedIntakeReply(
  conversationId: string,
  replyText: string
): Promise<ResolvedRow[]> {
  const db = await getDb();
  const openRows = await db
    .select()
    .from(pendingConfirmations)
    .where(
      and(eq(pendingConfirmations.conversationId, conversationId), eq(pendingConfirmations.status, "pending"))
    );

  const batched = openRows.filter((row) => row.groupIndex !== null);
  if (batched.length < 2) return [];

  const numbers = [...replyText.matchAll(/\d+/g)].map((match) => Number.parseInt(match[0], 10));
  if (numbers.length === 0) return [];

  const resolved: ResolvedRow[] = [];
  const seenGroupIndexes = new Set<number>();
  for (const n of numbers) {
    const groupIndex = Math.floor((n - 1) / 2);
    if (seenGroupIndexes.has(groupIndex)) continue;
    const row = batched.find((r) => r.groupIndex === groupIndex);
    if (!row) continue;
    const confirmed = (n - 1) % 2 === 0;
    const updated = await resolve(row.organizationId, row.id, confirmed, replyText);
    if (updated) {
      resolved.push(updated);
      seenGroupIndexes.add(groupIndex);
    }
  }
  return resolved;
}
