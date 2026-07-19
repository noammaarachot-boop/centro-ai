import Link from "next/link";
import { Search } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getDashboardCounts,
  listQueue,
  searchClients,
  type DashboardQueue,
} from "@/lib/data/dashboard";
import { StatusBadge } from "../collections/StatusBadge";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";

const QUEUE_CARDS: Array<{ queue: DashboardQueue; label: string }> = [
  { queue: "active", label: "בקשות איסוף פעילות" },
  { queue: "waiting_for_client", label: "ממתין ללקוח" },
  { queue: "needs_review", label: "דורש בדיקת עובד" },
  { queue: "processing_documents", label: "מסמכים בעיבוד" },
  { queue: "completed_today", label: "הושלמו היום" },
];

const QUEUE_TITLES: Record<DashboardQueue, string> = {
  active: "בקשות איסוף פעילות",
  waiting_for_client: "ממתין ללקוח",
  needs_review: "דורש בדיקת עובד",
  processing_documents: "מסמכים בעיבוד",
  completed_today: "הושלמו היום",
};

function relativeTime(date: Date) {
  const diffMs = Date.now() - new Date(date).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "עכשיו";
  if (minutes < 60) return `לפני ${minutes} דקות`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שעות`;
  const days = Math.round(hours / 24);
  return `לפני ${days} ימים`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ queue?: string; q?: string }>;
}) {
  const session = await requireSession();
  const { queue, q } = await searchParams;

  const searchResults = q?.trim() ? await searchClients(session.organizationId, q.trim()) : null;

  if (queue && queue in QUEUE_TITLES) {
    const rows = await listQueue(session.organizationId, queue as DashboardQueue);

    return (
      <div className="mx-auto max-w-4xl px-6 py-12">
        <Link href="/dashboard" className="text-sm text-text-muted hover:text-brand-purple">
          ← חזרה ללוח הבקרה
        </Link>
        <h1 className="mt-2 mb-6 text-2xl font-semibold text-text-primary">
          {QUEUE_TITLES[queue as DashboardQueue]}
        </h1>

        {rows.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-border bg-surface-muted px-6 py-10 text-center text-sm text-text-muted">
            אין בקשות איסוף בתור זה כרגע.
          </p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
            <table className="w-full text-end text-sm">
              <thead className="bg-surface-muted text-text-muted">
                <tr>
                  <th className="px-4 py-3 font-medium">לקוח</th>
                  <th className="px-4 py-3 font-medium">התקדמות</th>
                  <th className="px-4 py-3 font-medium">מסמכים חסרים</th>
                  <th className="px-4 py-3 font-medium">פעילות אחרונה</th>
                  <th className="px-4 py-3 font-medium">סטטוס</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border hover:bg-surface-muted">
                    <td className="px-4 py-3">
                      <Link
                        href={`/collections/${row.id}`}
                        className="font-medium text-text-primary hover:text-brand-purple"
                      >
                        {row.clientName}
                      </Link>
                      <p className="text-xs text-text-muted">
                        {row.serviceName} · {row.periodLabel}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">{row.progressPercent}%</td>
                    <td className="px-4 py-3 text-text-secondary">
                      {row.missingDocuments.length > 0 ? row.missingDocuments.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {relativeTime(row.lastActivity)}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={row.status as CollectionRequestStatus} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  const counts = await getDashboardCounts(session.organizationId);
  const countsByQueue: Record<DashboardQueue, { count: number; percentage: number }> = {
    active: counts.active,
    waiting_for_client: counts.waitingForClient,
    needs_review: counts.needsReview,
    processing_documents: counts.documentsProcessing,
    completed_today: counts.completedToday,
  };

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="mb-1 text-2xl font-semibold text-text-primary">
        ברוכים הבאים, {session.organizationName}
      </h1>
      <p className="mb-6 text-sm text-text-secondary">
        תמונת מצב של העבודה הפעילה, לא רשימת כל הלקוחות.
      </p>

      <form action="/dashboard" method="GET" className="mb-6 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            name="q"
            type="text"
            defaultValue={q ?? ""}
            placeholder="חיפוש לקוח לפי שם או טלפון..."
            className="w-full rounded-xl border border-border bg-white ps-9 pe-4 py-2.5 text-sm text-text-primary outline-none focus:border-brand-purple"
          />
        </div>
        <button
          type="submit"
          className="rounded-full border border-border px-4 py-2.5 text-sm font-medium text-text-secondary hover:border-brand-purple hover:text-brand-purple"
        >
          חיפוש
        </button>
      </form>

      {searchResults && (
        <div className="mb-8 rounded-2xl border border-border bg-surface p-4 shadow-card">
          {searchResults.length === 0 ? (
            <p className="text-sm text-text-muted">לא נמצאו לקוחות תואמים.</p>
          ) : (
            <ul className="space-y-1">
              {searchResults.map((client) => (
                <li key={client.id}>
                  <Link
                    href={`/clients/${client.id}`}
                    className="block rounded-lg px-3 py-2 text-sm text-text-primary hover:bg-surface-muted"
                  >
                    {client.name} <span className="text-text-muted" dir="ltr">({client.phone})</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {QUEUE_CARDS.map(({ queue: cardQueue, label }) => {
          const { count, percentage } = countsByQueue[cardQueue];
          return (
            <Link
              key={cardQueue}
              href={`/dashboard?queue=${cardQueue}`}
              className="rounded-2xl border border-border bg-surface p-5 shadow-card transition-colors hover:border-brand-purple"
            >
              <p className="text-sm text-text-muted">{label}</p>
              <p className="mt-2 text-3xl font-semibold text-text-primary">{count}</p>
              <p className="mt-1 text-xs text-text-muted">{percentage}% מהפעילות</p>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
