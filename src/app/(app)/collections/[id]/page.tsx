import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
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
import {
  getCollectionRequest,
  listRequirementsWithDocuments,
  listUnmatchedDocuments,
} from "@/lib/data/collectionRequests";
import {
  getConversationByCollectionRequest,
  listMessages,
} from "@/lib/conversationOrchestration";
import {
  nextStatusOptions,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";
import { driveFileLink } from "@/lib/storage/driveAdapter";
import { listAuditLog } from "@/lib/data/auditLog";
import { listOpenConfirmationsForCollectionRequest } from "@/lib/pendingConfirmations";
import { getOrganization } from "@/lib/data/organizations";
import { StatusBadge } from "../StatusBadge";
import {
  addManualDocument,
  assignDocumentRequirement,
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
  respondToConfirmation,
  sendEmployeeMessage,
  simulateInboundMessage,
  takeOverConversation,
} from "../conversationActions";
import { Card } from "@/components/app/Card";
import { Badge, type BadgeTone } from "@/components/app/Badge";
import { buttonVariants } from "@/components/app/Button";
import { EmptyState } from "@/components/app/EmptyState";
import { fieldClass } from "@/components/app/FormField";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { DevToolsPanel } from "@/components/app/DevToolsPanel";

const TRANSITION_LABELS: Record<CollectionRequestStatus, string> = {
  draft: "חזרה לטיוטה",
  active: "הפעלה",
  waiting_for_client: "המתנה ללקוח",
  processing: "העברה לעיבוד",
  completed: "השלמה",
  escalated: "הסלמה",
  cancelled: "ביטול",
};

const DOCUMENT_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  received: { label: "התקבל", tone: "blue" },
  processing: { label: "בעיבוד", tone: "purple" },
  approved: { label: "אושר", tone: "success" },
  rejected: { label: "נדחה", tone: "danger" },
  needs_review: { label: "דורש בדיקה", tone: "warning" },
  deleted_from_drive: { label: "נמחק מ-Drive", tone: "neutral" },
};

const CONVERSATION_STATUS_META: Record<string, { label: string; tone: BadgeTone }> = {
  open: { label: "פתוחה", tone: "blue" },
  waiting_for_client: { label: "ממתינה לתשובת לקוח", tone: "warning" },
  human_control: { label: "בשליטת עובד", tone: "purple" },
  closed: { label: "סגורה", tone: "neutral" },
};

const compactButtonClass = buttonVariants({ variant: "secondary", size: "sm" });
const pillButtonClass = buttonVariants({ variant: "secondary", size: "sm" });

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

  const organization = await getOrganization(session.organizationId);
  const serviceWord = organization?.workflowType === "one_time" ? "לתבנית זו" : "לשירות זה";

  const requirements = await listRequirementsWithDocuments(id);
  const unmatchedDocuments = await listUnmatchedDocuments(id);
  const options = nextStatusOptions(collectionRequest.status);
  const boundTransition = transitionStatus.bind(null, id);

  const conversation = await getConversationByCollectionRequest(id);
  const messages = conversation ? await listMessages(conversation.id) : [];
  const auditHistory = await listAuditLog(session.organizationId, { collectionRequestId: id });
  const openConfirmations = await listOpenConfirmationsForCollectionRequest(id);

  return (
    <div className="mx-auto max-w-2xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div>
        <Link
          href="/collections"
          className="mb-3 inline-flex items-center gap-1 text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          חזרה לבקשות איסוף
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[26px] font-bold tracking-tight text-text-primary">
            {collectionRequest.clientName} — {collectionRequest.serviceName}
          </h1>
          <StatusBadge status={collectionRequest.status} />
        </div>
        <p className="mt-1.5 text-sm text-text-secondary">
          תקופה: {collectionRequest.periodLabel}
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          {decodeURIComponent(error)}
        </p>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">שינוי סטטוס</h2>
        {options.length === 0 ? (
          <p className="text-sm text-text-muted">אין פעולות זמינות (סטטוס סופי).</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {options.map((status) => (
              <form key={status} action={boundTransition.bind(null, status)}>
                <button type="submit" className={pillButtonClass}>
                  {collectionRequest.status === "completed" && status === "active"
                    ? "פתיחה מחדש"
                    : TRANSITION_LABELS[status]}
                </button>
              </form>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">דרישות מסמכים</h2>
        {requirements.length === 0 ? (
          <p className="text-sm text-text-muted">אין דרישות מסמכים מוגדרות {serviceWord}.</p>
        ) : (
          <ul className="space-y-4">
            {requirements.map((requirement) => (
              <li
                key={requirement.id}
                className="rounded-xl border border-border bg-surface-muted/30 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium text-text-primary">{requirement.name}</p>
                  {requirement.documents.length === 0 && (
                    <form action={waiveRequirement.bind(null, id, requirement.id)}>
                      <button
                        type="submit"
                        className="text-[11px] text-text-muted transition-colors hover:text-warning hover:underline"
                      >
                        לא רלוונטי הפעם
                      </button>
                    </form>
                  )}
                </div>

                {requirement.documents.length > 0 && (
                  <ul className="mt-3 space-y-2.5">
                    {requirement.documents.map((doc) => {
                      const meta = DOCUMENT_STATUS_META[doc.status];
                      return (
                        <li key={doc.id} className="text-xs text-text-secondary">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-text-primary">
                              {doc.fileName}
                            </span>
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
                            <div className="mt-1.5 flex items-center justify-between text-[11px] text-text-muted">
                              <a
                                href={driveFileLink(doc.googleDriveFileId)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-brand-blue transition-colors hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                פתיחה ב-Google Drive
                              </a>
                              <ConfirmDialog
                                title="הדמיית מחיקה מ-Drive"
                                description={`לדמות מחיקה ידנית של "${doc.fileName}" מ-Google Drive? זו סימולציה לבדיקות בלבד.`}
                                confirmLabel="הדמיית מחיקה"
                                formAction={simulateDriveDeletion.bind(null, id, doc.id)}
                                triggerClassName="inline-flex items-center gap-1 text-text-muted transition-colors hover:text-danger hover:underline"
                                trigger={
                                  <>
                                    <Trash2 className="h-3 w-3" />
                                    הדמיית מחיקה מ-Drive
                                  </>
                                }
                              />
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

                <form
                  action={addManualDocument.bind(null, id, requirement.id)}
                  className="mt-3 flex items-center gap-2"
                >
                  <input
                    name="fileName"
                    type="text"
                    required
                    placeholder="שם קובץ (הוספה ידנית)"
                    className={fieldClass("sm", "flex-1")}
                  />
                  <select name="status" className={fieldClass("sm")}>
                    <option value="approved">אישור</option>
                    <option value="needs_review">דורש בדיקה</option>
                    <option value="rejected">דחייה</option>
                  </select>
                  <button type="submit" className={compactButtonClass}>
                    הוספה
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {unmatchedDocuments.length > 0 && (
        <Card className="border-warning/30 bg-warning/5">
          <div className="mb-4 flex items-center gap-2">
            <FileWarning className="h-5 w-5 shrink-0 text-warning" />
            <h2 className="text-lg font-semibold text-text-primary">מסמכים ללא שיוך</h2>
          </div>
          <p className="mb-4 text-sm text-text-muted">
            הסיווג האוטומטי לא הצליח לשייך מסמכים אלו לדרישה בביטחון מספק (BR-11.3) — נדרש
            שיוך ידני.
          </p>
          <ul className="space-y-3">
            {unmatchedDocuments.map((doc) => (
              <li key={doc.id} className="rounded-xl border border-border bg-surface p-3">
                <p className="mb-2 text-sm font-medium text-text-primary">{doc.fileName}</p>
                <form
                  action={assignDocumentRequirement.bind(null, id, doc.id)}
                  className="space-y-2"
                >
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
              </li>
            ))}
          </ul>
        </Card>
      )}

      {openConfirmations.length > 0 && (
        <Card className="border-brand-purple/30 bg-brand-purple/5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldQuestion className="h-5 w-5 shrink-0 text-brand-purple" />
            <h2 className="text-lg font-semibold text-text-primary">ממתין לאישור הלקוח</h2>
          </div>
          <p className="mb-4 text-sm text-text-muted">
            נשלחה שאלת אישור בוואטסאפ (Ch.3: Observe → Suggest → Confirm → Learn) — ממתינים
            לתשובת הלקוח, או שאפשר לסמן ידנית.
          </p>
          <ul className="space-y-3">
            {openConfirmations.map((confirmation) => (
              <li key={confirmation.id} className="rounded-xl border border-border bg-surface p-3">
                <p className="mb-2 text-sm text-text-primary">{confirmation.question}</p>
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
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 shrink-0 text-brand-purple" />
            <h2 className="text-lg font-semibold text-text-primary">שיחת וואטסאפ</h2>
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
              <ul className="mb-4 max-h-80 space-y-2 overflow-y-auto">
                {messages.map((message) => {
                  const isAi = message.direction === "outbound" && message.senderType === "ai";
                  return (
                    <li
                      key={message.id}
                      className={
                        isAi
                          ? "centro-ai-gradient ms-auto max-w-[80%] rounded-2xl rounded-es-sm px-3 py-2 text-xs text-white"
                          : message.direction === "outbound"
                            ? "ms-auto max-w-[80%] rounded-2xl rounded-es-sm bg-brand-purple/10 px-3 py-2 text-xs text-text-primary"
                            : "me-auto max-w-[80%] rounded-2xl rounded-ee-sm bg-surface-muted px-3 py-2 text-xs text-text-primary"
                      }
                    >
                      <p>{message.body}</p>
                      <p
                        className={
                          isAi ? "mt-0.5 text-[10px] text-white/75" : "mt-0.5 text-[10px] text-text-muted"
                        }
                      >
                        {message.senderType} ·{" "}
                        {new Date(message.createdAt).toLocaleTimeString("he-IL")}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
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
              {conversation.status === "human_control" ? (
                <form action={releaseConversation.bind(null, id)}>
                  <button type="submit" className={pillButtonClass}>
                    שחרור שליטה אוטומטית
                  </button>
                </form>
              ) : (
                <form action={takeOverConversation.bind(null, id)}>
                  <button type="submit" className={pillButtonClass}>
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
                className={fieldClass("sm", "flex-1")}
              />
              <button type="submit" className={compactButtonClass}>
                שליחה
              </button>
            </form>

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
            </DevToolsPanel>
          </>
        )}
      </Card>

      <Card>
        <div className="mb-4 flex items-center gap-2">
          <ScrollText className="h-5 w-5 shrink-0 text-text-muted" />
          <h2 className="text-lg font-semibold text-text-primary">היסטוריית ביקורת</h2>
        </div>
        {auditHistory.length === 0 ? (
          <p className="text-sm text-text-muted">אין עדיין רשומות עבור בקשה זו.</p>
        ) : (
          <ul className="space-y-2">
            {auditHistory.map((event) => (
              <li key={event.id} className="text-xs text-text-secondary">
                <span className="text-text-muted">
                  {new Date(event.occurredAt).toLocaleString("he-IL")} ·{" "}
                </span>
                {event.description}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
