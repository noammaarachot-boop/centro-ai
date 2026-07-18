import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import {
  getCollectionRequest,
  listRequirementsWithDocuments,
} from "@/lib/data/collectionRequests";
import {
  nextStatusOptions,
  type CollectionRequestStatus,
} from "@/lib/collectionRequestStateMachine";
import { StatusBadge } from "../StatusBadge";
import { addManualDocument, transitionStatus } from "../actions";

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
                  <ul className="mt-2 space-y-1">
                    {requirement.documents.map((doc) => (
                      <li
                        key={doc.id}
                        className="flex items-center justify-between text-xs text-text-secondary"
                      >
                        <span>{doc.fileName}</span>
                        <span>{DOCUMENT_STATUS_LABELS[doc.status]}</span>
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
    </div>
  );
}
