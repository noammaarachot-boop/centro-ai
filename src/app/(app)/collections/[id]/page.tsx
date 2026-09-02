import Link from "next/link";
import { notFound } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  ExternalLink,
  FileWarning,
  MessageCircle,
  ScrollText,
  Send,
  ShieldQuestion,
  Trash2,
  X,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import {
  getCollectionRequest,
  listDocumentsByWhatsappMessageId,
  listRequirementsWithDocuments,
  listUnmatchedDocuments,
} from "@/lib/data/collectionRequests";
import {
  getConversationByCollectionRequest,
  isFreeformWindowOpen,
  listMessages,
} from "@/lib/conversationOrchestration";
import {
  computeRequirementsProgress,
  nextStatusOptions,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";
import { getItemsNeedingReview, getLastActivityAtByRequest } from "@/lib/data/dashboardReadModel";
import { resolveDocumentDisplayLabel, resolveMessageDisplayBody } from "@/lib/documents/displayLabel";
import { formatRelativeTime } from "@/lib/formatRelativeTime";
import { driveFileLink } from "@/lib/storage/driveAdapter";
import { SUPPORTED_EXTENSIONS } from "@/lib/ai/documentClassifier";
import { listAuditLog } from "@/lib/data/auditLog";
import { filterUserFacingActivity } from "@/lib/activityHistory";
import { describeRequestPeriodDetail } from "@/lib/requestLabel";
import { resolveRequestAttentionState } from "@/lib/requestAttentionState";
import { RequestAttentionPanel } from "@/components/app/RequestAttentionPanel";
import { daysSince, describeEscalation } from "@/lib/elapsedTime";
import { checkIntegrationStatus } from "@/lib/integrationRequirements";
import {
  DELIVERY_STATE_LABEL,
  hasReachedClient,
  resolveMessageDeliveryState,
} from "@/lib/messageDeliveryState";
import { listOpenConfirmationsForCollectionRequest } from "@/lib/pendingConfirmations";
import {
  DRIVE_NOT_READY_MESSAGE,
  WHATSAPP_NOT_READY_MESSAGE,
} from "@/lib/integrationRequirements";
import { StatusBadge } from "../StatusBadge";
import { RequirementDocumentUpload } from "../RequirementDocumentUpload";
import {
  assignDocumentRequirement,
  resolveRequirementExceptionAction,
  resolveReviewItemFromRequest,
  reviewDocument,
  simulateDriveDeletion,
  transitionStatus,
  waiveRequirement,
} from "../actions";
import {
  evaluateNow,
  initiateConversation,
  markFinished,
  markMoreDocuments,
  releaseConversation,
  respondToClarification,
  respondToConfirmation,
  retryFailedMessage,
  sendReminderNow,
  sendEmployeeMessageWithFeedback,
  simulateInboundMessage,
  takeOverConversation,
} from "../conversationActions";
import { Card } from "@/components/app/Card";
import { Badge, type BadgeTone } from "@/components/app/Badge";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { fieldClass } from "@/components/app/FormField";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { MessageComposer } from "@/components/app/MessageComposer";
import { ConversationScroll } from "@/components/app/ConversationScroll";
import { DevToolsPanel } from "@/components/app/DevToolsPanel";
import { devToolsEnabled } from "@/lib/devTools";
import { formatDateAndTime } from "@/lib/formatDateTime";

const TRANSITION_LABELS: Record<CollectionRequestStatus, string> = {
  draft: "חזרה לטיוטה",
  active: "הפעלה",
  waiting_for_client: "המתנה ללקוח",
  processing: "העברה לעיבוד",
  completed: "השלמה",
  escalated: "העברה לטיפול",
  cancelled: "ביטול",
};

// Human, direct wording ("דורש בדיקה שלך", not just "דורש בדיקה") — every
// document row speaks to the employee reading it, per the approved sketch.
const DOCUMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  received: { label: "התקבל, ממתין לבדיקה", tone: "blue" },
  processing: { label: "בעיבוד", tone: "purple" },
  approved: { label: "אושר", tone: "success" },
  rejected: { label: "נדחה", tone: "danger" },
  needs_review: { label: "דורש בדיקה שלך", tone: "warning" },
  deleted_from_drive: { label: "נמחק מ-Drive", tone: "neutral" },
  // Ch.6 3-way document intake split (src/lib/documentIntakeReview.ts) —
  // these never reach this per-requirement list in practice (they carry no
  // requirementId until resolved), but are listed defensively so a status
  // badge never renders undefined if that ever changes.
  unsolicited_pending_confirmation: { label: "ממתין לאישור הלקוח (לא נדרש)", tone: "purple" },
  unsolicited_approved: { label: "אושר כמסמך נוסף", tone: "success" },
  unsolicited_rejected: { label: "נשלח בטעות", tone: "neutral" },
  clarification_requested: { label: "ממתין להבהרת הלקוח", tone: "purple" },
  identity_anomaly_pending_confirmation: { label: "ממתין לאישור זהות מהלקוח", tone: "purple" },
  identity_anomaly_confirmed: { label: "אושר על ידי הלקוח (חריגת זהות)", tone: "success" },
  identity_anomaly_rejected: { label: "נשלח בטעות (חריגת זהות)", tone: "neutral" },
};

const CONVERSATION_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: "פתוחה", tone: "blue" },
  waiting_for_client: { label: "ממתינה לתשובת לקוח", tone: "warning" },
  human_control: { label: "בשליטת עובד", tone: "purple" },
  closed: { label: "סגורה", tone: "neutral" },
};

// Who wrote a message, in words a person uses. The column stores the audit
// actor enum ("ai" | "employee" | "client" | "system"), which was being
// rendered verbatim under every bubble.
const SENDER_LABEL: Record<string, string> = {
  ai: "Centro",
  employee: "המשרד",
  client: "הלקוח",
  system: "מערכת",
};

const SUPPORTED_DOCUMENT_ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(",");

const compactButtonClass = buttonVariants({ variant: "secondary", size: "sm" });
const pillButtonClass = buttonVariants({ variant: "secondary", size: "sm" });

// Cheap, non-AI "looks like the employee is probably done" signal — a
// passive dashboard suggestion only, never a state change on its own; the
// employee must still explicitly click the release button.
const SUGGEST_RELEASE_IDLE_MS = 15 * 60 * 1000;

// A client deferral is only worth showing while it is still in the future.
// "נדחה עד 09:00" read at 14:00 tells the reader nothing and contradicts
// the status beside it. Kept as a function so the time lookup does not
// happen inline during render.
function isDeferralStillPending(deferredReminderAt: Date | null | undefined): boolean {
  if (!deferredReminderAt) return false;
  return new Date(deferredReminderAt).getTime() > Date.now();
}
function computeShouldSuggestReleasingControl(
  conversationStatus: string | undefined,
  lastMessage: { senderType: string; createdAt: Date } | undefined
): boolean {
  if (conversationStatus !== "human_control") return false;
  if (!lastMessage || lastMessage.senderType !== "employee") return false;
  return Date.now() - lastMessage.createdAt.getTime() >= SUGGEST_RELEASE_IDLE_MS;
}

// The command-center summary line — composed entirely from numbers already
// computed below (progress, the needs-attention counts, open confirmations)
// for THIS one request. Never a new signal, never invented text — same
// discipline as the dashboard's own buildBriefing/buildHero.
function buildSummaryLine(params: {
  status: CollectionRequestStatus;
  escalationReason: string | null;
  daysOpen: number;
  attentionCount: number;
  unsatisfiedCount: number;
  waitingOnClientCount: number;
}): string {
  const { status, escalationReason, daysOpen, attentionCount, unsatisfiedCount, waitingOnClientCount } = params;
  // Never the stored string as-is: it carries the 3-day THRESHOLD frozen in
  // at escalation time, which contradicted the real age shown just below.
  if (status === "escalated") return describeEscalation(escalationReason, daysOpen);
  if (attentionCount > 0 && unsatisfiedCount > 0) {
    return `${attentionCount} דברים מחכים לטיפולך, וחסרים עוד ${unsatisfiedCount} מסמכים מהלקוח`;
  }
  if (attentionCount > 0) return `${attentionCount} דברים מחכים לטיפולך`;
  if (unsatisfiedCount > 0) return `חסרים עוד ${unsatisfiedCount} מסמכים מהלקוח`;
  if (waitingOnClientCount > 0) return "ממתינים לתשובת הלקוח";
  if (status === "completed") return "כל המסמכים התקבלו ואושרו";
  return "הכול תקין כרגע";
}

export default async function CollectionRequestDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { error } = await searchParams;

  const collectionRequest = await getCollectionRequest(session.organizationId, id);
  if (!collectionRequest) notFound();

  // Every time shown on this page is formatted in the ORGANIZATION's zone.
  // Without an explicit zone these rendered in the server process's zone —
  // UTC on Vercel — so the conversation was stamped three hours off while
  // the deferral banner beside it already used Asia/Jerusalem.
  const organization = await getOrganization(session.organizationId);
  const organizationTimezone = organization?.timezone ?? "Asia/Jerusalem";
  const integrationStatus = await checkIntegrationStatus(session.organizationId);
  const periodDetail = describeRequestPeriodDetail(
    collectionRequest.serviceName ?? "",
    collectionRequest.periodLabel
  );

  const requirements = await listRequirementsWithDocuments(id);
  const unmatchedDocuments = await listUnmatchedDocuments(id);
  const options = nextStatusOptions(collectionRequest.status);
  const boundTransition = transitionStatus.bind(null, id);
  // UX simplification — the state machine itself (nextStatusOptions/
  // canTransition/applyTransition, collectionRequestStateMachine.ts) is
  // completely unchanged; only which of its already-legal transitions get
  // a button on this screen. HIDDEN_WORKFLOW_TARGETS are system-driven
  // states an employee rarely needs to force manually and that read as
  // unclear buttons; "cancelled" isn't hidden, just moved out of this
  // primary row into its own secondary/destructive control below.
  // "active" joins the hidden set: as a bare button it read "הפעלה" and
  // did nothing but flip status, which on an already-active request with a
  // failed message looked like a remedy and was not. Reactivating a draft
  // is offered by the attention panel instead, where it says what it does.
  const HIDDEN_WORKFLOW_TARGETS: CollectionRequestStatus[] = ["waiting_for_client", "processing", "escalated", "active"];
  const visibleTransitionOptions = options.filter(
    (status) => status !== "cancelled" && !HIDDEN_WORKFLOW_TARGETS.includes(status)
  );
  const canCancel = options.includes("cancelled");
  // UX simplification — "הדמיית מחיקה מ-Drive" is explicitly a testing-only
  // simulation (its own ConfirmDialog copy already says so), not a real
  // per-document action an office employee needs inline on every approved
  // row. Moved into the same DevToolsPanel pattern this page already uses
  // for the WhatsApp simulator, rather than removed — still fully
  // available, just no longer part of the main document list's clutter.
  const driveDocumentsForSimulation = requirements.flatMap((requirement) =>
    requirement.documents
      .filter((doc) => doc.status === "approved" && doc.googleDriveFileId)
      .map((doc) => ({ id: doc.id, label: resolveDocumentDisplayLabel(doc.displayLabel, requirement.name) }))
  );

  const conversation = await getConversationByCollectionRequest(id);
  const messages = conversation ? await listMessages(conversation.id) : [];
  // Display-layer filter only — every event is still recorded and still
  // readable in full on the /audit screen. This drops internal engine
  // chatter and the per-message "sent" rows the conversation already shows,
  // so the timeline reads as what happened to the request.
  const auditHistory = filterUserFacingActivity(
    await listAuditLog(session.organizationId, { collectionRequestId: id })
  );
  const openConfirmations = await listOpenConfirmationsForCollectionRequest(id);

  // Display-layer only — never rewrites the stored message. A historical
  // inbound message that was only an attachment was recorded with
  // ATTACHMENT_PLACEHOLDER_TEXT at intake time, before classification had
  // run (see the webhook route's own comment). Once the matching document
  // (same whatsappMessageId) has a real resolveDocumentDisplayLabel(), the
  // thread shows that instead — still never the raw storage filename.
  const requirementNameById = new Map(requirements.map((r) => [r.id, r.name]));
  const documentsWithWhatsappId = await listDocumentsByWhatsappMessageId(id);
  const documentLabelByWhatsappMessageId = new Map(
    documentsWithWhatsappId
      .filter((doc): doc is typeof doc & { whatsappMessageId: string } => doc.whatsappMessageId !== null)
      .map((doc) => [
        doc.whatsappMessageId,
        resolveDocumentDisplayLabel(doc.displayLabel, doc.requirementId ? requirementNameById.get(doc.requirementId) : null),
      ])
  );

  // Command-center numbers — every one of them a direct read of the real
  // engine's own state, never a parallel calculation:
  //  - progress: computeRequirementsProgress, the exact function
  //    checkCompletionGate itself uses for X/Y and "what's missing".
  //  - needsReviewItems: getItemsNeedingReview (dashboardReadModel.ts),
  //    filtered to this one request — the same union the owner dashboard
  //    already uses, never a second definition of "needs review".
  //  - lastActivity: getLastActivityAtByRequest, same function, one-id call.
  const progress = await computeRequirementsProgress(id);
  const allNeedsReview = await getItemsNeedingReview(session.organizationId);
  const myReviewReasons = allNeedsReview.find((item) => item.collectionRequestId === id)?.reasons ?? [];
  const employeeQuestions = myReviewReasons.filter((r) => r.kind === "employee_question");
  const lastActivityMap = await getLastActivityAtByRequest([id]);
  const lastActivity = lastActivityMap.get(id) ?? null;

  // A failed send is deliberately NOT part of this count. It is reported
  // once, by the attention panel, which is the only place that also offers a
  // way to fix it — the delivery signal itself comes from the same shared
  // resolver the message bubbles use, so "did this reach the client" is
  // still decided in exactly one place.
  const attentionCount = unmatchedDocuments.length + employeeQuestions.length;

  // ONE resolver decides what this request needs and which single action
  // addresses it — see src/lib/requestAttentionState.ts for why the old
  // stack of sentences plus an "הפעלה" button was the problem.
  const lastOutbound = [...messages].reverse().find((m) => m.direction === "outbound");
  // Measured at every render from the request's own createdAt — never a
  // stored snapshot — so the figure keeps climbing on its own with no new
  // escalation, and a refresh can never bring an older number back.
  const daysOpen = daysSince(collectionRequest.createdAt, organizationTimezone);
  const attentionState = resolveRequestAttentionState({
    status: collectionRequest.status,
    lastOutboundDeliveryStatus: lastOutbound?.deliveryStatus ?? null,
    clientHasReplied: messages.some((m) => m.direction === "inbound"),
    unsatisfiedCount: progress.unsatisfiedCount,
    reviewItemCount: unmatchedDocuments.length + employeeQuestions.length,
    whatsappReady: integrationStatus.whatsappReady,
    hasConversation: !!conversation,
    // A template send (senderType "ai") is always retryable. Plain text is
    // only accepted inside the 24h window a client message opens — this is
    // exactly what failed in production: the client had never written in, so
    // the window had never been open, and every resend was refused with the
    // same error.
    retryCanSucceed: lastOutbound?.senderType === "ai" || isFreeformWindowOpen(messages),
    // The last automated message that actually reached the provider. A
    // reminder that failed is not a reminder the client could reply to, so
    // it must not put the request into "waiting for a reply".
    lastReminderSentAt:
      [...messages]
        .reverse()
        .find(
          (m) =>
            m.direction === "outbound" &&
            m.senderType === "ai" &&
            hasReachedClient(m)
        )?.createdAt ?? null,
    clientRepliedSinceReminder: (() => {
      const reminder = [...messages]
        .reverse()
        .find((m) => m.direction === "outbound" && m.senderType === "ai" && hasReachedClient(m));
      if (!reminder) return false;
      return messages.some(
        (m) => m.direction === "inbound" && new Date(m.createdAt) > new Date(reminder.createdAt)
      );
    })(),
    daysOpen,
  });
  const attentionAction =
    attentionState.primaryAction?.kind === "retry_send"
      ? retryFailedMessage.bind(null, id)
      : attentionState.primaryAction?.kind === "send_reminder"
        ? sendReminderNow.bind(null, id)
        : null;
  const summaryLine = buildSummaryLine({
    status: collectionRequest.status,
    escalationReason: collectionRequest.escalationReason,
    daysOpen,
    attentionCount,
    unsatisfiedCount: progress.unsatisfiedCount,
    waitingOnClientCount: openConfirmations.length,
  });

  const lastMessage = messages[messages.length - 1];
  const shouldSuggestReleasingControl = computeShouldSuggestReleasingControl(
    conversation?.status,
    lastMessage ? { senderType: lastMessage.senderType, createdAt: new Date(lastMessage.createdAt) } : undefined
  );

  // No "recent" / "older" split. Slicing the last three messages into their
  // own list outside the scroller is what made them look pinned while the
  // rest of the thread moved; the thread renders as one list now, and the
  // slice is gone rather than merely unused so it cannot quietly return.

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-4 py-10 sm:px-6 lg:px-10">
      <Link
        href="/collections"
        className="inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        חזרה לבקשות איסוף
      </Link>

      {error && (
        <div
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          <p>{decodeURIComponent(error)}</p>
          {(decodeURIComponent(error) === WHATSAPP_NOT_READY_MESSAGE ||
            decodeURIComponent(error) === DRIVE_NOT_READY_MESSAGE) && (
            <Link href="/settings" className="mt-1.5 inline-block text-sm font-semibold underline">
              מעבר להגדרות לחיבור מחדש
            </Link>
          )}
        </div>
      )}

      {/* ===== Command center header ===== */}
      <div className="centro-glass-strong relative overflow-hidden rounded-[28px] border border-border p-7 shadow-card-lg">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-[6%] -inset-y-[30%] -z-10 blur-[24px]"
          style={{
            background:
              attentionCount > 0 || collectionRequest.status === "escalated"
                ? "radial-gradient(50% 90% at 20% 20%, color-mix(in oklab, var(--color-danger) 12%, transparent), transparent 70%), radial-gradient(45% 90% at 85% 60%, color-mix(in oklab, var(--color-brand-purple) 10%, transparent), transparent 70%)"
                : "radial-gradient(50% 90% at 20% 20%, color-mix(in oklab, var(--color-brand-emerald) 10%, transparent), transparent 70%), radial-gradient(45% 90% at 85% 60%, color-mix(in oklab, var(--color-brand-cyan) 10%, transparent), transparent 70%)",
          }}
        />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text-primary">
              {collectionRequest.clientName} — {collectionRequest.serviceName}
            </h1>
            <p className="mt-0.5 text-xs text-text-muted">
              {/* The heading above already names the client and the request.
                  For a template-created request the "period" is that same name
                  plus the date it was opened, so only the date is new here. */}
              {periodDetail && (
                <>
                  {periodDetail.label}: {periodDetail.value}
                  {lastActivity && " · "}
                </>
              )}
              {lastActivity && <>עדכון אחרון: {formatRelativeTime(lastActivity)}</>}
            </p>
          </div>
          {/* Same signal the panel below renders from, so the chip and the
              panel can never disagree about whether anything is wrong. */}
          <StatusBadge
            status={collectionRequest.status}
            hasOpenAttention={attentionState.kind !== "none"}
          />
        </div>

        <p className="mt-3 text-sm font-semibold text-text-primary">{summaryLine}</p>

        <RequestAttentionPanel state={attentionState} action={attentionAction} />

        {/* Two different things write conversations.deferredReminderAt: a
            genuine client request ("אשלח מחר" — reminderDeferral.ts, which
            also stores the client's own words), and the scheduler deferring
            a reminder that came due outside business hours, which is
            Centro's own decision and stores nothing else. This banner
            claimed BOTH were the client's doing. Across production every
            single deferral on record is the scheduler's — 11 of 11 — so
            every time this text has ever appeared it attributed to a client
            something they never asked for. The stored client text is the
            evidence, so it is what the wording keys off. */}
        {/* Only while it is still true, and only when it is the CLIENT's.
            Two changes here, both about not saying things that are no
            longer useful:
            • A deferral whose time has passed is stale. "נדחה עד 09:00"
              at 14:00 tells the reader nothing and quietly contradicts the
              status beside it.
            • The scheduler's own out-of-hours deferral is bookkeeping, not
              news: the office cannot act on it, it resolves itself when the
              day opens, and it was the thing being mistaken for a client
              request. It stays in the audit trail, where it belongs, and is
              no longer shown here at all. */}
        {collectionRequest.status !== "escalated" &&
          conversation?.deferredReminderAt &&
          conversation.deferredReminderOriginalText &&
          isDeferralStillPending(conversation.deferredReminderAt) && (
            <p className="mt-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm font-medium text-warning">
              נדחה לבקשת הלקוח עד{" "}
              {new Date(conversation.deferredReminderAt).toLocaleString("he-IL", {
                dateStyle: "short",
                timeStyle: "short",
                timeZone: organizationTimezone,
              })}{" "}
              — דחייה {collectionRequest.deferralCount} מתוך 2 (&quot;
              {conversation.deferredReminderOriginalText}&quot;)
            </p>
          )}

        {/* Counters UX simplification — "התקבלו" is the one number that
            always matters and always shows. "לטיפולך"/"מחכה ללקוח" are
            secondary counts that are only ever meaningful once they're
            non-zero (a "0" tile has nothing for the employee to act on and
            just adds visual noise) — flex-wrap rather than a fixed 3-column
            grid so the row still reads as intentional whether it's showing
            one tile or three, not a grid with empty-looking gaps. */}
        <div className="mt-5 flex flex-wrap gap-2.5">
          <div className="min-w-[132px] flex-1 rounded-2xl border border-border bg-surface px-3.5 py-3">
            <p className="text-[11px] font-semibold text-text-muted">התקבלו</p>
            <p className="mt-1 text-xl font-bold tabular-nums text-text-primary">
              {progress.satisfiedCount}/{progress.totalCount}
            </p>
            <p className="text-[10.5px] text-text-muted">מסמכים</p>
          </div>
          {attentionCount > 0 && (
            <div className="min-w-[132px] flex-1 rounded-2xl border border-border bg-surface px-3.5 py-3">
              <p className="text-[11px] font-semibold text-text-muted">לטיפולך</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-danger">{attentionCount}</p>
              <p className="text-[10.5px] text-text-muted">פריטים</p>
            </div>
          )}
          {openConfirmations.length > 0 && (
            <div className="min-w-[132px] flex-1 rounded-2xl border border-border bg-surface px-3.5 py-3">
              <p className="text-[11px] font-semibold text-text-muted">מחכה ללקוח</p>
              <p className="mt-1 text-xl font-bold tabular-nums text-text-primary">{openConfirmations.length}</p>
              <p className="text-[10.5px] text-text-muted">שאלות פתוחות</p>
            </div>
          )}
        </div>

        {/* Workflow-actions UX simplification — "המתנה ללקוח"/"העברה
            לעיבוד"/"הסלמה" are system-driven transitions the office rarely
            needs to force by hand and that weren't clear as buttons; hidden
            from this row (nextStatusOptions/applyTransition/the statuses
            themselves are completely untouched — an already
            waiting_for_client/processing/escalated request still works
            exactly as before, this only removes the manual "push it into
            that state yourself" buttons). Every OTHER real transition (e.g.
            reopening from completed, or marking complete once processing)
            still shows here unchanged.

            "ביטול בקשה" sits at the END of this same row, pushed away from
            the routine actions by an auto margin and styled as destructive,
            so it's findable where an employee already looks for actions
            without being adjacent enough to hit by accident. It previously
            lived near the bottom of the page in muted grey, which in
            practice was invisible. */}
        {(visibleTransitionOptions.length > 0 || canCancel) && (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-4">
            {visibleTransitionOptions.map((status) => (
              <form key={status} action={boundTransition.bind(null, status)}>
                <button type="submit" className={pillButtonClass}>
                  {collectionRequest.status === "completed" && status === "active"
                    ? "פתיחה מחדש"
                    : TRANSITION_LABELS[status]}
                </button>
              </form>
            ))}
            {canCancel && (
              <div className="ms-auto">
                <ConfirmDialog
                  title="לבטל את הבקשה?"
                  description="הביטול יחול רק על הלקוח הזה. לא יישלחו יותר תזכורות או הודעות עבור הבקשה הזו. מסמכים שכבר התקבלו יישמרו בתיק הלקוח."
                  confirmLabel="כן, לבטל את הבקשה"
                  cancelLabel="חזרה"
                  formAction={boundTransition.bind(null, "cancelled")}
                  // py-2, not py-1.5, so this matches the pillButtonClass
                  // buttons it shares a row with. Those are border + py-2 +
                  // text-xs = 34px; at py-1.5 this one rendered 30px, so it
                  // sat 4px short of its own row AND was the only control
                  // on this screen under the touch-target floor. Measured,
                  // both are now 34px. This is the one change here that is
                  // deliberately visible.
                  triggerClassName="inline-flex items-center gap-1.5 rounded-full border border-danger/30 bg-danger/5 px-3.5 py-2 text-xs font-semibold text-danger transition-colors hover:border-danger/60 hover:bg-danger/10"
                  trigger={
                    <span className="flex items-center gap-1.5">
                      <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                      ביטול בקשה
                    </span>
                  }
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* ===== דורש תשומת לב שלך — only rendered when there's something real to show ===== */}
      {attentionCount > 0 && (
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-base font-bold text-text-primary">
            <AlertTriangle className="h-4.5 w-4.5 text-danger" aria-hidden="true" />
            דורש תשומת לב שלך
            <span className="inline-grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-extrabold text-white">
              {attentionCount}
            </span>
          </h2>
          <div className="space-y-2.5">
            {/* The failed-send warning used to be repeated here, worded as
                "כדאי לבדוק את השיחה למטה" — a second copy of what the
                attention panel already says, with no action attached. The
                panel is the single source for it now. */}
            {employeeQuestions.map((reason) => (
              <Card key={reason.sourceId} className="border-warning/30 bg-warning/5" padding="sm">
                <div className="flex items-start gap-2.5">
                  <span className="centro-icon-warning grid h-8 w-8 shrink-0 place-items-center rounded-lg">
                    <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary">שאלת לקוח ממתינה למענה</p>
                    <p className="mt-0.5 text-xs text-text-secondary">&ldquo;{reason.detail}&rdquo;</p>
                    <form
                      action={resolveReviewItemFromRequest.bind(null, id, reason.sourceId!)}
                      className="mt-2 flex items-center gap-2"
                    >
                      <input
                        type="text"
                        name="resolutionText"
                        required
                        placeholder="התשובה שלך ללקוח..."
                        className={fieldClass("sm", "flex-1")}
                      />
                      <button type="submit" className={compactButtonClass}>
                        שליחת מענה
                      </button>
                    </form>
                  </div>
                </div>
              </Card>
            ))}

            {unmatchedDocuments.map((doc) => (
              <Card key={doc.id} className="border-warning/30 bg-warning/5" padding="sm">
                <div className="flex items-start gap-2.5">
                  <span className="centro-icon-warning grid h-8 w-8 shrink-0 place-items-center rounded-lg">
                    <FileWarning className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-text-primary">
                      מסמך לבדיקה: {resolveDocumentDisplayLabel(doc.displayLabel)}
                    </p>
                    <p className="mt-0.5 text-xs text-text-secondary">
                      הסיווג האוטומטי לא הצליח לשייך אותו לדרישה בביטחון מספק — נדרש שיוך ידני.
                    </p>
                    <form action={assignDocumentRequirement.bind(null, id, doc.id)} className="mt-2 space-y-2">
                      <div className="flex items-center gap-2">
                        <select name="requirementId" className={fieldClass("sm", "flex-1")}>
                          <option value="">— בחירת דרישה קיימת —</option>
                          {requirements.map((requirement) => (
                            <option key={requirement.id} value={requirement.id}>
                              {requirement.name}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className={compactButtonClass}>
                          שיוך
                        </button>
                      </div>
                      <input
                        name="newTypeName"
                        type="text"
                        placeholder="או: סוג מסמך חדש שלא ברשימה (למשל: טופס 102)"
                        className={fieldClass("sm")}
                      />
                      <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        <input
                          type="checkbox"
                          name="askClient"
                          className="h-3.5 w-3.5 rounded border-border accent-brand-purple"
                        />
                        בשיוך לדרישה קיימת: לשאול את הלקוח אם זה מסמך קבוע (וואטסאפ)
                      </label>
                    </form>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* ===== מסמכים נדרשים ===== */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">מסמכים נדרשים</h2>
        {requirements.length === 0 ? (
          <p className="text-sm text-text-muted">אין דרישות מסמכים מוגדרות לאיסוף זה.</p>
        ) : (
          <ul className="space-y-4">
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className="rounded-xl border border-border bg-surface-muted/30 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">{requirement.name}</p>
                  <div className="flex items-center gap-2">
                    {requirement.documents.length === 0 && !requirement.exceptionStatus && (
                      <Badge tone="neutral">טרם התקבל</Badge>
                    )}
                    {requirement.documents.length === 0 && (
                      <form action={waiveRequirement.bind(null, id, requirement.id)}>
                        <button
                          type="submit"
                          // A real action (it waives a requirement) that
                          // rendered 17px tall. Padding plus the matching
                          // negative margin takes the tap area to 33px
                          // without moving anything around it.
                          className="py-2 -my-2 text-[11px] text-text-muted transition-colors hover:text-warning hover:underline"
                        >
                          לא רלוונטי הפעם
                        </button>
                      </form>
                    )}
                  </div>
                </div>

                {requirement.exceptionStatus === "reported_missing" && (
                  <div className="mt-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
                    <p className="text-xs font-medium text-warning">
                      הלקוח דיווח שאין ברשותו את המסמך הזה — נדרשת החלטה
                    </p>
                    {requirement.exceptionNote && (
                      <p className="mt-1 text-xs text-text-secondary">
                        הניסוח שהלקוח כתב: &ldquo;{requirement.exceptionNote}&rdquo;
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap gap-2">
                      <form action={resolveRequirementExceptionAction.bind(null, id, requirement.id)}>
                        <input type="hidden" name="decision" value="waive" />
                        <button
                          type="submit"
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-success hover:text-success"
                        >
                          ויתור על הדרישה
                        </button>
                      </form>
                      <form action={resolveRequirementExceptionAction.bind(null, id, requirement.id)}>
                        <input type="hidden" name="decision" value="contact_client" />
                        <button
                          type="submit"
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-brand-blue hover:text-brand-blue"
                        >
                          יצירת קשר עם הלקוח
                        </button>
                      </form>
                      <form action={resolveRequirementExceptionAction.bind(null, id, requirement.id)}>
                        <input type="hidden" name="decision" value="leave_open" />
                        <button
                          type="submit"
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-text-muted"
                        >
                          השאר פתוח
                        </button>
                      </form>
                    </div>
                    <form
                      action={resolveRequirementExceptionAction.bind(null, id, requirement.id)}
                      className="mt-2 flex flex-wrap items-center gap-2"
                    >
                      <input type="hidden" name="decision" value="request_alternative" />
                      <input
                        type="text"
                        name="alternativeText"
                        placeholder="מסמך חלופי לבקש במקום..."
                        className={fieldClass("sm", "flex-1 min-w-[180px]")}
                      />
                      <button
                        type="submit"
                        className="rounded-full border border-border px-2.5 py-1 text-[11px] text-text-secondary transition-colors hover:border-brand-blue hover:text-brand-blue"
                      >
                        בקשת מסמך חלופי
                      </button>
                    </form>
                  </div>
                )}

                {requirement.documents.length > 0 && (
                  <ul className="mt-3 space-y-2.5">
                    {requirement.documents.map((doc) => {
                      const meta = DOCUMENT_STATUS_META[doc.status];
                      const label = resolveDocumentDisplayLabel(doc.displayLabel, requirement.name);
                      return (
                        <li key={doc.id} className="text-xs text-text-secondary">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-text-primary">{label}</span>
                            <div className="flex items-center gap-2">
                              <Badge tone={meta.tone}>{meta.label}</Badge>
                              {doc.status !== "approved" && doc.status !== "rejected" && (
                                <div className="flex gap-1">
                                  <form action={reviewDocument.bind(null, id, doc.id)}>
                                    <input type="hidden" name="decision" value="approved" />
                                    <button
                                      type="submit"
                                      className="inline-flex items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-success transition-colors hover:border-success"
                                    >
                                      <Check className="h-3 w-3" />
                                      אישור
                                    </button>
                                  </form>
                                  <form action={reviewDocument.bind(null, id, doc.id)}>
                                    <input type="hidden" name="decision" value="rejected" />
                                    <button
                                      type="submit"
                                      className="inline-flex items-center gap-0.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-danger transition-colors hover:border-danger"
                                    >
                                      <X className="h-3 w-3" />
                                      דחייה
                                    </button>
                                  </form>
                                </div>
                              )}
                            </div>
                          </div>
                          {doc.status === "approved" && doc.googleDriveFileId && (
                            <div className="mt-1.5">
                              <a
                                href={driveFileLink(doc.googleDriveFileId)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-[11px] text-brand-blue transition-colors hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                פתיחה ב-Google Drive
                              </a>
                            </div>
                          )}
                          {doc.status === "deleted_from_drive" && doc.driveDeletedAt && (
                            <p className="mt-1.5 text-[11px] text-danger">
                              נמחק ידנית ב-
                              {new Date(doc.driveDeletedAt).toLocaleDateString("he-IL")}{" "}
                              {new Date(doc.driveDeletedAt).toLocaleTimeString("he-IL", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </p>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="mt-3">
                  <RequirementDocumentUpload
                    collectionRequestId={id}
                    requirementId={requirement.id}
                    hasExistingDocuments={requirement.documents.length > 0}
                    acceptExtensions={SUPPORTED_DOCUMENT_ACCEPT}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {devToolsEnabled() && driveDocumentsForSimulation.length > 0 && (
          <div className="mt-4">
            <DevToolsPanel label="הדמיית מחיקה מ-Drive">
              <ul className="space-y-2">
                {driveDocumentsForSimulation.map((doc) => (
                  <li key={doc.id} className="flex items-center justify-between gap-2">
                    <span className="text-xs text-text-secondary">{doc.label}</span>
                    <ConfirmDialog
                      title="הדמיית מחיקה מ-Drive"
                      description={`לדמות מחיקה ידנית של "${doc.label}" מ-Google Drive? זו סימולציה לבדיקות בלבד.`}
                      confirmLabel="הדמיית מחיקה"
                      formAction={simulateDriveDeletion.bind(null, id, doc.id)}
                      triggerClassName="inline-flex items-center gap-1 text-xs text-text-muted transition-colors hover:text-danger hover:underline"
                      trigger={
                        <>
                          <Trash2 className="h-3 w-3" />
                          הדמיית מחיקה
                        </>
                      }
                    />
                  </li>
                ))}
              </ul>
            </DevToolsPanel>
          </div>
        )}
      </Card>

      {/* ===== מחכה לתשובת הלקוח ===== */}
      {openConfirmations.length > 0 && (
        <Card className="border-brand-purple/30 bg-brand-purple/5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldQuestion className="h-5 w-5 shrink-0 text-brand-purple" />
            <h2 className="text-lg font-semibold text-text-primary">ממתין לאישור הלקוח</h2>
          </div>
          <p className="mb-4 text-sm text-text-muted">
            נשלחה שאלת אישור בוואטסאפ — ממתינים לתשובת הלקוח, או שאפשר לסמן ידנית.
          </p>
          <ul className="space-y-3">
            {openConfirmations.map((confirmation) => (
              <li key={confirmation.id} className="rounded-xl border border-border bg-surface p-3">
                <p className="mb-2 text-sm text-text-primary">{confirmation.question}</p>
                {confirmation.kind === "document_clarification" ? (
                  <form
                    action={respondToClarification.bind(null, id, confirmation.id)}
                    className="flex gap-2"
                  >
                    <input
                      type="text"
                      name="replyText"
                      placeholder="מה הלקוח ענה לגבי המסמך?"
                      required
                      className="flex-1 rounded-full border border-border px-3 py-1.5 text-xs text-text-primary"
                    />
                    <button
                      type="submit"
                      className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-brand-purple transition-colors hover:border-brand-purple"
                    >
                      שלח תשובה
                    </button>
                  </form>
                ) : (
                  <div className="flex gap-2">
                    <form action={respondToConfirmation.bind(null, id, confirmation.id, true)}>
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-success transition-colors hover:border-success"
                      >
                        <Check className="h-3 w-3" />
                        הלקוח אישר
                      </button>
                    </form>
                    <form action={respondToConfirmation.bind(null, id, confirmation.id, false)}>
                      <button
                        type="submit"
                        className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:border-danger"
                      >
                        <X className="h-3 w-3" />
                        הלקוח סירב
                      </button>
                    </form>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ===== וואטסאפ — מצומצם =====
          The target of "פתיחת השיחה" in the attention panel. That link
          pointed at #conversation while nothing on the page carried the id,
          so clicking it did nothing at all. scroll-mt keeps the heading
          clear of the sticky header once it lands. */}
      <Card id="conversation" className="scroll-mt-24">
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 shrink-0 text-brand-purple" />
            <h2 className="text-lg font-semibold text-text-primary">וואטסאפ</h2>
          </div>
          {conversation && (
            <Badge tone={CONVERSATION_STATUS_META[conversation.status].tone}>
              {CONVERSATION_STATUS_META[conversation.status].label}
            </Badge>
          )}
        </div>

        {!conversation ? (
          <form action={initiateConversation.bind(null, id)}>
            <button type="submit" className={buttonVariants({ variant: "primary" })}>
              <Send className="h-4 w-4" />
              שליחת פנייה ראשונית
            </button>
          </form>
        ) : (
          <>
            {messages.length === 0 ? (
              <EmptyState
                icon={ShieldQuestion}
                title="אין הודעות עדיין"
                description="השיחה נפתחה אך טרם נשלחו או התקבלו הודעות."
              />
            ) : (
              /* ONE bounded scroll region holding EVERY message.

                 No split between older and recent: that split is exactly
                 what made the three newest messages look pinned, because
                 they sat outside the scroller the rest of the thread used.
                 One list, one scroller, opened at the newest message. */
              <ConversationScroll>
                <ul className="space-y-2">
                  {messages.map((message) => (
                    <MessageBubble
                      organizationTimezone={organizationTimezone}
                      key={message.id}
                      message={message}
                      documentLabelByWhatsappMessageId={documentLabelByWhatsappMessageId}
                    />
                  ))}
                </ul>
              </ConversationScroll>
            )}

            {/* Cancelled is terminal (collectionRequestStateMachine.ts) — no
                further engagement is meaningful, so every action here
                (simulated client replies, human-control handoff, manual
                employee send, the inbound-message simulator below) is
                hidden. The message history above stays visible either
                way — read-only viewing of what already happened is always
                allowed. */}
            {collectionRequest.status !== "cancelled" && (
              <>
                {/* Only real, employee-facing actions live here now. The
                    three controls that used to sit alongside them — "run
                    evaluation (inactivity simulation)", "client replied:
                    done", "client replied: more documents" — were
                    developer stand-ins from before WhatsApp was live, and
                    they were reaching real tenants: they rendered for every
                    user in production, inside the conversation, looking
                    like ordinary actions. They now sit in the DevToolsPanel
                    below with the rest of the simulators, so they exist in
                    development and cannot be reached in production. */}
                <div className="flex flex-wrap gap-2 border-t border-border pt-4">
                  {conversation.status === "human_control" ? (
                    <form action={releaseConversation.bind(null, id)}>
                      <button type="submit" className={pillButtonClass}>
                        החזר לטיפול אוטומטי
                      </button>
                    </form>
                  ) : (
                    <ConfirmDialog
                      title="העבר לטיפול אנושי"
                      description="ה-AI יפסיק לענות אוטומטית ללקוח בבקשה זו, והמשך השיחה יעבור לטיפול המשרד. ניתן להחזיר את הטיפול האוטומטי בכל שלב."
                      confirmLabel="העבר לטיפול אנושי"
                      formAction={takeOverConversation.bind(null, id)}
                      triggerClassName={pillButtonClass}
                      trigger="העבר לטיפול אנושי"
                    />
                  )}
                </div>

                {shouldSuggestReleasingControl && (
                  <div className="mt-2 rounded-lg border border-brand-purple/30 bg-brand-purple/5 px-3 py-2 text-xs text-text-primary">
                    נראה שהטיפול הסתיים. להחזיר לטיפול אוטומטי? (ניתן ללחוץ על הכפתור למעלה)
                  </div>
                )}

                <MessageComposer action={sendEmployeeMessageWithFeedback.bind(null, id)} />
              </>
            )}

            {devToolsEnabled() && collectionRequest.status !== "cancelled" && (
              <DevToolsPanel label="סימולציית הודעה נכנסת מהלקוח">
                <form action={simulateInboundMessage.bind(null, id)} className="space-y-2">
                  <p className="text-[11px] text-text-muted">
                    הדמיית הודעה נכנסת מהלקוח (עד לחיבור WhatsApp אמיתי). קובץ מצורף עובר סיווג
                    אוטומטי (AI מדומה) שמשייך אותו לדרישה המתאימה — בחירה ידנית להלן עוקפת את
                    הסיווג.
                  </p>
                  <input
                    name="body"
                    type="text"
                    placeholder="טקסט ההודעה"
                    className={fieldClass("sm")}
                  />
                  <div className="flex items-center gap-2">
                    <input
                      name="fileName"
                      type="text"
                      placeholder="שם קובץ מצורף (לא חובה)"
                      className={fieldClass("sm", "flex-1")}
                    />
                    <select name="requirementId" className={fieldClass("sm")}>
                      <option value="">— סיווג אוטומטי —</option>
                      {requirements.map((requirement) => (
                        <option key={requirement.id} value={requirement.id}>
                          {requirement.name} (ידני)
                        </option>
                      ))}
                    </select>
                    <button type="submit" className={compactButtonClass}>
                      הדמיה
                    </button>
                  </div>
                </form>

                {/* Client-reply and inactivity stand-ins from before
                    WhatsApp was live. They drive real state transitions, so
                    they stay available in development — but they are not
                    something a real tenant should ever see, let alone click
                    inside a conversation with their own client. */}
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border/60 pt-3">
                  <form action={evaluateNow.bind(null, id)}>
                    <button type="submit" className={pillButtonClass}>
                      הרצת הערכה (סימולציית חוסר פעילות)
                    </button>
                  </form>
                  <form action={markFinished.bind(null, id)}>
                    <button type="submit" className={pillButtonClass}>
                      הלקוח השיב: סיימתי
                    </button>
                  </form>
                  <form action={markMoreDocuments.bind(null, id)}>
                    <button type="submit" className={pillButtonClass}>
                      הלקוח השיב: יש עוד מסמכים
                    </button>
                  </form>
                </div>
              </DevToolsPanel>
            )}
          </>
        )}
      </Card>

      {/* ===== היסטוריית פעילות — מקופלת כברירת מחדל =====
          What HAPPENED to the request, as opposed to the conversation above,
          which is what was SAID to the client. The two must not repeat each
          other — see filterUserFacingActivity. */}
      <details className="group rounded-2xl border border-border bg-surface-muted/40">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-semibold text-text-secondary transition-colors hover:text-text-primary">
          <ScrollText className="h-4 w-4 shrink-0" aria-hidden="true" />
          היסטוריית פעילות
        </summary>
        <div className="border-t border-border px-5 py-4">
          {auditHistory.length === 0 ? (
            <p className="text-sm text-text-muted">אין עדיין פעילות מתועדת בבקשה זו.</p>
          ) : (
            <ul className="space-y-2">
              {auditHistory.map((event) => (
                <li key={event.id} className="text-xs text-text-secondary">
                  <span className="text-text-muted">
                    {formatDateAndTime(event.occurredAt, organizationTimezone)} ·{" "}
                  </span>
                  {event.description}
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </div>
  );
}

function MessageBubble({
  message,
  documentLabelByWhatsappMessageId,
  organizationTimezone,
}: {
  message: {
    id: string;
    direction: string;
    senderType: string;
    body: string;
    createdAt: Date | string;
    whatsappMessageId: string | null;
    deliveryStatus?: string | null;
  };
  documentLabelByWhatsappMessageId: Map<string, string>;
  organizationTimezone: string;
}) {
  const isOutbound = message.direction === "outbound";
  // Display-layer upgrade only (see the page's own comment on
  // documentLabelByWhatsappMessageId) — the stored message row is never
  // rewritten. Still never the raw storage filename either way.
  const resolvedLabel = message.whatsappMessageId
    ? documentLabelByWhatsappMessageId.get(message.whatsappMessageId)
    : undefined;
  const displayBody = resolveMessageDisplayBody(message.body, resolvedLabel);
  const deliveryState = resolveMessageDeliveryState(message.deliveryStatus);
  const reached = hasReachedClient(message);
  return (
    /* Two tones only, and neither of them shouts.

       Messages from the office (both the AI's and an employee's) used to
       differ from each other — one a full-strength blue/purple gradient in
       white text, the other a purple tint — while the client's sat in the
       same neutral grey as the page furniture. Three treatments for two
       speakers, with the loudest reserved for the side the reader cares
       least about identifying. Now: everything we send is calm neutral, and
       the client's own words carry the single soft accent, so "who wrote
       this" reads instantly without any colour competing with the text. */
    <li
      className={
        isOutbound
          ? "ms-auto max-w-[80%] break-words rounded-2xl rounded-es-sm border border-border bg-surface-muted px-3 py-2 text-xs text-text-primary"
          : "me-auto max-w-[80%] break-words rounded-2xl rounded-ee-sm border border-brand-purple/20 bg-brand-purple/10 px-3 py-2 text-xs text-text-primary"
      }
    >
      <p>{displayBody}</p>
      <p className="mt-0.5 text-[10px] text-text-muted">
        {/* The raw enum used to be printed here — "ai", "employee",
            "client" — which is both jargon and, for the client, wrong: the
            person reading it knows who the client is by name. */}
        {SENDER_LABEL[message.senderType] ?? message.senderType} ·{" "}
        {/* An explicit timeZone. Without one this formats in whatever zone
            the RENDERING process happens to be in — UTC on Vercel — so every
            message in the thread was stamped three hours earlier than it
            actually happened, while the deferral banner a few hundred lines
            up already passed Asia/Jerusalem and disagreed with it. */}
        {new Date(message.createdAt).toLocaleTimeString("he-IL", {
          timeZone: organizationTimezone,
          hour: "2-digit",
          minute: "2-digit",
        })}
        {/* Outbound only: an inbound message is with us by definition.
            Without this every row looked like a delivered WhatsApp message,
            including the 114 that WhatsApp had refused. */}
        {isOutbound && !reached && (
          <span className="ms-1.5 font-semibold text-danger">· {DELIVERY_STATE_LABEL[deliveryState]}</span>
        )}
      </p>
    </li>
  );
}
