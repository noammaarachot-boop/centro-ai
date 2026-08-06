import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { collectionRequests, pendingConfirmations } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { sendOutboundMessage } from "@/lib/conversationOrchestration";
import {
  CONFIRM_NO_BUTTON_ID,
  CONFIRM_YES_BUTTON_ID,
  createPendingConfirmation,
  listOpenConfirmationsForCollectionRequest,
  type PendingConfirmationKind,
} from "@/lib/pendingConfirmations";
import { getConfirmationReminderConfig } from "@/lib/documentIntakeReview";
import { attemptFinishCollectionRequest } from "@/lib/caseReview";
import type { InteractiveButton } from "@/lib/whatsapp/send";

/**
 * Post-completion extension flow — once a client confirms "yes, save the
 * extra documents" after a request already completed (src/lib/requestReopen.ts),
 * Centro must not assume they're done the moment a single document arrives:
 * they may want to add several, and the request only genuinely closes again
 * once they explicitly say so (an ordinary "finished" signal) or confirm it
 * via the nudge this module sends after a period of inactivity. See
 * collectionRequests.extensionActive's own schema doc comment for exactly
 * what "active" suppresses (processInboundAttachment's immediate-completion
 * check).
 */

const FINISHED_CHECK_BUTTONS: InteractiveButton[] = [
  { id: CONFIRM_YES_BUTTON_ID, title: "כן, סיימתי" },
  { id: CONFIRM_NO_BUTTON_ID, title: "לא, יש עוד" },
];

// After this many minutes with no further activity on an active extension,
// Centro asks once rather than waiting indefinitely or nagging immediately
// — the middle of the 30-60 minute window the product spec asks for.
export const EXTENSION_NUDGE_AFTER_MINUTES = 30;

export async function activateExtension(collectionRequestId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(collectionRequests)
    .set({ extensionActive: true })
    .where(eq(collectionRequests.id, collectionRequestId));
}

// Called by the scheduler for every collection request with an active
// extension whose conversation has gone quiet past the nudge threshold — a
// no-op if a finished-check question is already open (never asks twice).
export async function createExtensionFinishedCheckIfDue(params: {
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
}): Promise<boolean> {
  const openConfirmations = await listOpenConfirmationsForCollectionRequest(params.collectionRequestId);
  if (openConfirmations.some((c) => c.kind === ("extension_finished_check" satisfies PendingConfirmationKind))) {
    return false;
  }

  const { reminderIntervalDays } = await getConfirmationReminderConfig(params.organizationId);
  await createPendingConfirmation({
    organizationId: params.organizationId,
    clientId: params.clientId,
    collectionRequestId: params.collectionRequestId,
    kind: "extension_finished_check" satisfies PendingConfirmationKind,
    payload: {},
    question: "סיימת להעלות את כל המסמכים הנוספים?",
    reminderIntervalDays,
    trigger: "automated",
    allowFreeform: true,
    interactiveButtons: FINISHED_CHECK_BUTTONS,
  });
  return true;
}

// A new document arriving while an extension is active supersedes any
// still-open "did you finish?" question — the client is clearly still
// active, and the timer naturally restarts via the client's own message
// already bumping conversations.updatedAt. Silently withdrawn (declined),
// never a message about it — asking again once the client genuinely goes
// quiet is what createExtensionFinishedCheckIfDue is for.
export async function withdrawStaleFinishedCheck(collectionRequestId: string): Promise<void> {
  const db = await getDb();
  const open = await listOpenConfirmationsForCollectionRequest(collectionRequestId);
  const stale = open.find((c) => c.kind === ("extension_finished_check" satisfies PendingConfirmationKind));
  if (!stale) return;
  await db
    .update(pendingConfirmations)
    .set({ status: "declined", respondedAt: new Date() })
    .where(eq(pendingConfirmations.id, stale.id));
}

interface ResolvedConfirmationRow {
  id: string;
  kind: string;
  status: string;
  organizationId: string;
  clientId: string;
  collectionRequestId: string;
  conversationId: string;
}

// No-op for any other confirmation kind. Confirmed ("כן, סיימתי") runs the
// exact same finish pipeline an explicit "finished" WhatsApp message would
// (case review, then completion) — attemptFinishCollectionRequest itself
// clears extensionActive once the request actually completes. Declined
// ("לא, יש עוד") just acknowledges and keeps waiting — no state change, the
// extension stays active for as long as it takes.
export async function applyExtensionFinishedDecision(resolved: ResolvedConfirmationRow): Promise<void> {
  if (resolved.kind !== ("extension_finished_check" satisfies PendingConfirmationKind)) return;

  if (resolved.status === "declined") {
    await sendOutboundMessage(
      resolved.organizationId,
      resolved.conversationId,
      "בסדר, אני כאן כשתסיים/י 🙂",
      "ai",
      "manual",
      undefined,
      true
    );
    return;
  }
  if (resolved.status !== "confirmed") return;

  await recordAuditEvent({
    organizationId: resolved.organizationId,
    eventType: "collection_request.extension_finished_confirmed",
    description: "הלקוח אישר שסיים להעלות מסמכים נוספים לאחר סיום הבקשה",
    actorType: "client",
    clientId: resolved.clientId,
    collectionRequestId: resolved.collectionRequestId,
  });

  await attemptFinishCollectionRequest({
    organizationId: resolved.organizationId,
    collectionRequestId: resolved.collectionRequestId,
    conversationId: resolved.conversationId,
    clientId: resolved.clientId,
    actorType: "client",
  });
}
