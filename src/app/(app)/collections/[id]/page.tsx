import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import {
  getCollectionRequest,
  listRequirementsWithDocuments,
} from "@/lib/data/collectionRequests";
import {
  getConversationByCollectionRequest,
  listMessages,
} from "@/lib/conversationOrchestration";
import {
  nextStatusOptions,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";
import { StatusBadge } from "../StatusBadge";
import { addManualDocument, reviewDocument, transitionStatus } from "../actions";
import {
  evaluateNow,
  initiateConversation,
  markFinished,
  markMoreDocuments,
  releaseConversation,
  sendEmployeeMessage,
  simulateInboundMessage,
  takeOverConversation,
} from "../conversationActions";

const TRANSITION_LABELS: Record<CollectionRequestStatus, string> = {
  draft: "חזרה לטיוטה",
  active: "הפעלה",
  waiting_for_client: "המתנה ללקוח",
  processing: "העברה לעיבוד",
  completed: "השלמה",
  escalated: "הסלמה",
  cancelled: "ביטול",
};

const DOCUMENT_STATUS_LABELS: Record<string, string> = {
  received: "התקבל",
  processing: "בעיבוד",
  approved: "אושר",
  rejected: "נדחה",
  needs_review: "דורש בדיקה",
  deleted_from_drive: "נמחק מ-Drive",
};

const CONVERSATION_STATUS_LABELS: Record<string, string> = {
  open: "פתוחה",
  waiting_for_client: "ממתינה לתשובת לקוח",
  human_control: "בשליטת עובד",
  closed: "סגורה",
};

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

  const requirements = await listRequirementsWithDocuments(id);
  const options = nextStatusOptions(collectionRequest.status);
  const boundTransition = transitionStatus.bind(null, id);

  const conversation = await getConversationByCollectionRequest(id);
  const messages = conversation ? await listMessages(conversation.id) : [];

  return (
    <div className="mx-auto max-w-2xl space-y-8 px-6 py-12">
      <div>
        <Link
          href="/collections"
          className="text-sm text-text-muted hover:text-brand-purple"
        >
          ← חזרה לבקשות איסוף
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-text-primary">
            {collectionRequest.clientName} — {collectionRequest.serviceName}
          </h1>
          <StatusBadge status={collectionRequest.status} />
        </div>
        <p className="mt-1 text-sm text-text-muted">
          תקופה: {collectionRequest.periodLabel}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger"
        >
          {decodeURIComponent(error)}
        </p>
      )}

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          שינוי סטטוס
        </h2>
        {options.length === 0 ? (
          <p className="text-sm text-text-muted">אין פעולות זמינות (סטטוס סופי).</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((status) => (
              <form key={status} action={boundTransition.bind(null, status)}>
                <button
                  type="submit"
                  className="rounded-full border border-border px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple"
                >
                  {collectionRequest.status === "completed" && status === "active"
                    ? "פתיחה מחדש"
                    : TRANSITION_LABELS[status]}
                </button>
              </form>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <h2 className="mb-4 text-lg font-semibold text-text-primary">
          דרישות מסמכים
        </h2>
        {requirements.length === 0 ? (
          <p className="text-sm text-text-muted">
            אין דרישות מסמכים מוגדרות לשירות זה.
          </p>
        ) : (
          <ul className="space-y-4">
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className="rounded-xl border border-border p-4"
              >
                <p className="text-sm font-medium text-text-primary">
                  {requirement.name}
                </p>

                {requirement.documents.length > 0 && (
                  <ul className="mt-2 space-y-2">
                    {requirement.documents.map((doc) => (
                      <li
                        key={doc.id}
                        className="flex items-center justify-between gap-2 text-xs text-text-secondary"
                      >
                        <span>{doc.fileName}</span>
                        <div className="flex items-center gap-2">
                          <span>{DOCUMENT_STATUS_LABELS[doc.status]}</span>
                          {doc.status !== "approved" && doc.status !== "rejected" && (
                            <div className="flex gap-1">
                              <form action={reviewDocument.bind(null, id, doc.id)}>
                                <input type="hidden" name="decision" value="approved" />
                                <button
                                  type="submit"
                                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-brand-emerald hover:border-brand-emerald"
                                >
                                  אישור
                                </button>
                              </form>
                              <form action={reviewDocument.bind(null, id, doc.id)}>
                                <input type="hidden" name="decision" value="rejected" />
                                <button
                                  type="submit"
                                  className="rounded-full border border-border px-2 py-0.5 text-[11px] text-danger hover:border-danger"
                                >
                                  דחייה
                                </button>
                              </form>
                            </div>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                <form
                  action={addManualDocument.bind(null, id, requirement.id)}
                  className="mt-3 flex items-center gap-2"
                >
                  <input
                    name="fileName"
                    type="text"
                    required
                    placeholder="שם קובץ (הוספה ידנית)"
                    className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                  />
                  <select
                    name="status"
                    className="rounded-lg border border-border bg-white px-2 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                  >
                    <option value="approved">אישור</option>
                    <option value="needs_review">דורש בדיקה</option>
                    <option value="rejected">דחייה</option>
                  </select>
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                  >
                    הוספה
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-6 shadow-card">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">שיחת וואטסאפ</h2>
          {conversation && (
            <span className="text-xs text-text-muted">
              {CONVERSATION_STATUS_LABELS[conversation.status]}
            </span>
          )}
        </div>

        {!conversation ? (
          <form action={initiateConversation.bind(null, id)}>
            <button
              type="submit"
              className="rounded-full bg-gradient-to-l from-brand-purple to-brand-blue px-4 py-2.5 text-sm font-semibold text-white shadow-card-lg"
            >
              שליחת פנייה ראשונית
            </button>
          </form>
        ) : (
          <>
            <ul className="mb-4 max-h-80 space-y-2 overflow-y-auto">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={
                    message.direction === "outbound"
                      ? "ms-auto max-w-[80%] rounded-2xl rounded-es-sm bg-brand-purple/10 px-3 py-2 text-xs text-text-primary"
                      : "me-auto max-w-[80%] rounded-2xl rounded-ee-sm bg-surface-muted px-3 py-2 text-xs text-text-primary"
                  }
                >
                  <p>{message.body}</p>
                  <p className="mt-0.5 text-[10px] text-text-muted">
                    {message.senderType} ·{" "}
                    {new Date(message.createdAt).toLocaleTimeString("he-IL")}
                  </p>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <form action={evaluateNow.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                >
                  הרצת הערכה (סימולציית חוסר פעילות)
                </button>
              </form>
              <form action={markFinished.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                >
                  הלקוח השיב: סיימתי
                </button>
              </form>
              <form action={markMoreDocuments.bind(null, id)}>
                <button
                  type="submit"
                  className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                >
                  הלקוח השיב: יש עוד מסמכים
                </button>
              </form>
              {conversation.status === "human_control" ? (
                <form action={releaseConversation.bind(null, id)}>
                  <button
                    type="submit"
                    className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                  >
                    שחרור שליטה אוטומטית
                  </button>
                </form>
              ) : (
                <form action={takeOverConversation.bind(null, id)}>
                  <button
                    type="submit"
                    className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                  >
                    השתלטות עובד
                  </button>
                </form>
              )}
            </div>

            <form
              action={sendEmployeeMessage.bind(null, id)}
              className="mt-3 flex items-center gap-2"
            >
              <input
                name="body"
                type="text"
                placeholder="הודעת עובד ידנית..."
                className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
              <button
                type="submit"
                className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
              >
                שליחה
              </button>
            </form>

            <form
              action={simulateInboundMessage.bind(null, id)}
              className="mt-3 space-y-2 rounded-xl border border-dashed border-border p-3"
            >
              <p className="text-[11px] text-text-muted">
                הדמיית הודעה נכנסת מהלקוח (עד לחיבור WhatsApp אמיתי)
              </p>
              <input
                name="body"
                type="text"
                placeholder="טקסט ההודעה"
                className="w-full rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
              />
              <div className="flex items-center gap-2">
                <input
                  name="fileName"
                  type="text"
                  placeholder="שם קובץ מצורף (לא חובה)"
                  className="flex-1 rounded-lg border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                />
                <select
                  name="requirementId"
                  className="rounded-lg border border-border bg-white px-2 py-2 text-xs text-text-primary outline-none focus:border-brand-purple"
                >
                  <option value="">— דרישה —</option>
                  {requirements.map((requirement) => (
                    <option key={requirement.id} value={requirement.id}>
                      {requirement.name}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="rounded-lg border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
                >
                  הדמיה
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
