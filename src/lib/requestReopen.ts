import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { conversations, documents } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage, reopenIfCompleted } from "@/lib/conversationOrchestration";
import {
  CONFIRM_NO_BUTTON_ID,
  CONFIRM_YES_BUTTON_ID,
  createPendingConfirmation,
  type PendingConfirmationKind,
} from "@/lib/pendingConfirmations";
import type { InteractiveButton } from "@/lib/whatsapp/send";

/**
 * Post-completion intent gate — "Centro only manages conversation from the
 * moment a request is sent until it's finally completed." Once completed,
 * a stray message must never silently reopen or mutate the request (a real
 * gap this closes: processInboundAttachment's own reopenIfCompleted used
 * to run unconditionally the moment any document arrived, no confirmation
 * asked at all). The one exception — the client explicitly referencing the
 * finished request or a document in it (see classifyReopenIntent) — still
 * requires an explicit yes/no before anything actually changes.
 */

const REOPEN_BUTTONS: InteractiveButton[] = [
  { id: CONFIRM_YES_BUTTON_ID, title: "כן, לשמור" },
  { id: CONFIRM_NO_BUTTON_ID, title: "לא" },
];

export type PostCompletionGateDecision =
  // Not closed, or an existing pending confirmation (most commonly this
  // exact reopen question, already asked) is still awaiting an answer —
  // the normal resolver chain handles it, this gate has nothing to add.
  | "fall_through"
  // Closed, nothing pending, and a document arrived — stash it and ask
  // before doing anything with it.
  | "stash_attachment"
  // Closed, nothing pending, no attachment, but the text explicitly
  // referenced the finished request/a document in it — ask before
  // reopening.
  | "ask_reopen"
  // Closed, nothing pending, nothing that warrants breaking the silence —
  // the safe default this whole gate exists to enforce.
  | "silent";

// The pure decision core of the post-completion intent gate — no DB, no
// WhatsApp, directly unit-testable. wantsReopen must already reflect
// classifyReopenIntent's own result when relevant (the caller only needs
// to actually invoke that AI classifier in the one case where it matters —
// closed, nothing pending, no attachment, real body text — see the webhook
// route, which short-circuits before ever calling it otherwise).
export function decidePostCompletionGate(params: {
  conversationStatus: string;
  hasOpenConfirmations: boolean;
  hasAttachment: boolean;
  wantsReopen: boolean;
}): PostCompletionGateDecision {
  if (params.conversationStatus !== "closed") return "fall_through";
  if (params.hasOpenConfirmations) return "fall_through";
  if (params.hasAttachment) return "stash_attachment";
  if (params.wantsReopen) return "ask_reopen";
  return "silent";
}

// Called when either (a) a document arrives on a closed conversation — an
// attachment is itself a meaningful signal, asked about regardless of any
// accompanying text — or (b) classifyReopenIntent recognized an explicit
// reference to the finished request in a text-only message. `documentId`
// is set only for (a): a document row already created with status
// "reopen_pending_confirmation", holding the file's bytes exactly like
// unsolicited_document does, never uploaded or classified until confirmed.
export async function createRequestReopenConfirmation(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  documentId: string | null;
}): Promise<void> {
  const question = params.documentId
    ? "הבקשה כבר הושלמה. לשמור גם את המסמך החדש בתיק?"
    : "הבקשה כבר הושלמה. לפתוח אותה מחדש כדי להשלים את מה שציינת?";

  console.log("[request-reopen] pending confirmation created", {
    organizationId: params.organizationId,
    collectionRequestId: params.collectionRequestId,
    hasDocument: !!params.documentId,
  });

  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "request_reopen" satisfies PendingConfirmationKind,
    payload: { documentId: params.documentId },
    question,
    trigger: "manual",
    allowFreeform: true,
    interactiveButtons: REOPEN_BUTTONS,
  });
}

interface ResolvedConfirmationRow {
  id: string;
  kind: string;
  status: string;
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
  payload: unknown;
}

// No-op for any other confirmation kind. On decline: the held document (if
// any) is dropped, never uploaded, the completed request stays completed —
// exactly the "stay silent" default this whole gate exists to protect. On
// confirm: reopens the request/conversation (reusing reopenIfCompleted's
// own audit trail), then — if a document was held — runs it through the
// real intake pipeline for the first time, now that the request is
// genuinely active again.
export async function applyRequestReopenDecision(
  resolved: ResolvedConfirmationRow,
  processDocument: (documentId: string) => Promise<void>
): Promise<void> {
  if (resolved.kind !== ("request_reopen" satisfies PendingConfirmationKind)) return;
  const payload = resolved.payload as { documentId: string | null } | null;
  const documentId = payload?.documentId ?? null;

  const db = await getDb();

  if (resolved.status === "declined") {
    if (documentId) {
      await db
        .update(documents)
        .set({ status: "reopen_declined", pendingFileContent: null, pendingFileMimeType: null, updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      await recordAuditEvent({
        organizationId: resolved.organizationId,
        eventType: "document.reopen_declined",
        description: "הלקוח בחר לא לשמור מסמך שנשלח לאחר סיום הבקשה — לא הועלה ל-Drive",
        actorType: "client",
        clientId: resolved.clientId,
        collectionRequestId: resolved.collectionRequestId,
        metadata: { documentId },
      });
    }
    console.log("[request-reopen] declined — request stays completed", { collectionRequestId: resolved.collectionRequestId });
    return;
  }

  if (resolved.status !== "confirmed") return;

  const reopened = await reopenIfCompleted(resolved.organizationId, resolved.collectionRequestId);
  if (reopened) {
    await db
      .update(conversations)
      .set({ status: "open", updatedAt: new Date() })
      .where(eq(conversations.id, resolved.conversationId));
  }
  console.log("[request-reopen] confirmed — request reopened", { collectionRequestId: resolved.collectionRequestId, reopened });

  if (documentId) {
    await processDocument(documentId);
  }

  await sendOutboundMessage(
    resolved.organizationId,
    resolved.conversationId,
    "מעולה, פתחתי את הבקשה מחדש. תודה!",
    "ai",
    "manual",
    undefined,
    true
  );
}
