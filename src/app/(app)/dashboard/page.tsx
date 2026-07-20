import Link from "next/link";
import {
  Activity,
  CheckCircle2,
  Clock,
  FileSearch,
  MessageCircleQuestion,
  Search,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import {
  getDashboardCounts,
  listBusinessTypeSuggestions,
  listPendingConfirmationsForDashboard,
  listQueue,
  searchClients,
  type DashboardQueue,
} from "@/lib/data/dashboard";
import { StatusBadge } from "../collections/StatusBadge";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/app/KpiCard";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";

const QUEUE_CARDS: Array<{
  queue: DashboardQueue;
  label: string;
  icon: typeof Activity;
  accent: "purple" | "blue" | "cyan" | "emerald" | "warning";
}> = [
  { queue: "active", label: "בקשות איסוף פעילות", icon: Activity, accent: "purple" },
  { queue: "waiting_for_client", label: "ממתין ללקוח", icon: Clock, accent: "warning" },
  { queue: "needs_review", label: "דורש בדיקת עובד", icon: ShieldAlert, accent: "blue" },
  { queue: "processing_documents", label: "מסמכים בעיבוד", icon: FileSearch, accent: "cyan" },
  { queue: "completed_today", label: "הושלמו היום", icon: CheckCircle2, accent: "emerald" },
  {
    queue: "business_type_suggestions",
    label: "הצעות סיווג לקוחות",
    icon: Sparkles,
    accent: "warning",
  },
  {
    queue: "pending_confirmations",
    label: "ממתין לאישור לקוח",
    icon: MessageCircleQuestion,
    accent: "blue",
  },
];

const QUEUE_TITLES: Record<DashboardQueue, string> = {
  active: "בקשות איסוף פעילות",
  waiting_for_client: "ממתין ללקוח",
  needs_review: "דורש בדיקת עובד",
  processing_documents: "מסמכים בעיבוד",
  completed_today: "הושלמו היום",
  business_type_suggestions: "הצעות סיווג לקוחות",
  pending_confirmations: "ממתין לאישור לקוח",
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

  // Milestone 4 — client-shaped, not collection-request-shaped like every
  // other queue, so it's its own branch with its own table columns rather
  // than trying to force it through the shared QueueRow rendering below.
  if (queue === "business_type_suggestions") {
    const suggestions = await listBusinessTypeSuggestions(session.organizationId);

    return (
      <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
        <Link
          href="/dashboard"
          className="mb-3 inline-flex items-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ← חזרה ללוח הבקרה
        </Link>
        <PageHeader
          title="הצעות סיווג לקוחות"
          description="סיווגים אוטומטיים בביטחון בינוני — כדאי לוודא, אך הם כבר פעילים ואינם דורשים פעולה מיידית."
        />

        {suggestions.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="אין הצעות סיווג הממתינות לבדיקה"
            description="כל הלקוחות המסווגים זוהו בביטחון גבוה, או שטרם יובאו לקוחות."
          />
        ) : (
          <Card padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-end text-sm">
                <thead className="sticky top-0 bg-surface-muted text-text-muted">
                  <tr>
                    <th className="px-5 py-3.5 font-medium">לקוח</th>
                    <th className="px-5 py-3.5 font-medium">סוג עסק מוצע</th>
                    <th className="px-5 py-3.5 font-medium">ביטחון</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border transition-colors hover:bg-surface-muted/60"
                    >
                      <td className="px-5 py-4">
                        <Link
                          href={`/clients/${row.id}`}
                          className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                        >
                          {row.name}
                        </Link>
                        <p className="text-xs text-text-muted" dir="ltr">
                          {row.phone}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-text-secondary">{row.businessTypeName ?? "—"}</td>
                      <td className="px-5 py-4">
                        <Badge tone="warning">{row.confidence}%</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    );
  }

  if (queue === "pending_confirmations") {
    const pending = await listPendingConfirmationsForDashboard(session.organizationId);

    return (
      <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
        <Link
          href="/dashboard"
          className="mb-3 inline-flex items-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ← חזרה ללוח הבקרה
        </Link>
        <PageHeader
          title="ממתין לאישור לקוח"
          description="שאלות אישור שנשלחו בוואטסאפ וטרם נענו (Ch.3: Observe → Suggest → Confirm → Learn)."
        />

        {pending.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="אין בקשות אישור פתוחות"
            description="כל בקשות האישור שנשלחו ללקוחות נענו."
          />
        ) : (
          <Card padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-end text-sm">
                <thead className="sticky top-0 bg-surface-muted text-text-muted">
                  <tr>
                    <th className="px-5 py-3.5 font-medium">לקוח</th>
                    <th className="px-5 py-3.5 font-medium">שאלה</th>
                    <th className="px-5 py-3.5 font-medium">נשלחה</th>
                  </tr>
                </thead>
                <tbody>
                  {pending.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border transition-colors hover:bg-surface-muted/60"
                    >
                      <td className="px-5 py-4">
                        <Link
                          href={`/collections/${row.collectionRequestId}`}
                          className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                        >
                          {row.clientName}
                        </Link>
                      </td>
                      <td className="px-5 py-4 text-text-secondary">{row.question}</td>
                      <td className="px-5 py-4 text-text-secondary">{relativeTime(row.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    );
  }

  if (queue && queue in QUEUE_TITLES) {
    const rows = await listQueue(session.organizationId, queue as DashboardQueue);

    return (
      <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
        <Link
          href="/dashboard"
          className="mb-3 inline-flex items-center text-sm text-text-muted transition-colors hover:text-brand-purple"
        >
          ← חזרה ללוח הבקרה
        </Link>
        <PageHeader title={QUEUE_TITLES[queue as DashboardQueue]} />

        {rows.length === 0 ? (
          <EmptyState
            icon={CheckCircle2}
            title="אין בקשות איסוף בתור זה כרגע"
            description="כל העבודה בתור הזה טופלה. תוכלו לחזור ללוח הבקרה ולבדוק תורים אחרים."
          />
        ) : (
          <Card padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-end text-sm">
                <thead className="sticky top-0 bg-surface-muted text-text-muted">
                  <tr>
                    <th className="px-5 py-3.5 font-medium">לקוח</th>
                    <th className="px-5 py-3.5 font-medium">התקדמות</th>
                    <th className="px-5 py-3.5 font-medium">מסמכים חסרים</th>
                    <th className="px-5 py-3.5 font-medium">פעילות אחרונה</th>
                    <th className="px-5 py-3.5 font-medium">סטטוס</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border transition-colors hover:bg-surface-muted/60"
                    >
                      <td className="px-5 py-4">
                        <Link
                          href={`/collections/${row.id}`}
                          className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                        >
                          {row.clientName}
                        </Link>
                        <p className="text-xs text-text-muted">
                          {row.serviceName} · {row.periodLabel}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
                            <div
                              className="h-full rounded-full bg-gradient-to-l from-brand-emerald to-brand-cyan transition-all duration-500"
                              style={{ width: `${row.progressPercent}%` }}
                            />
                          </div>
                          <span className="text-text-secondary">{row.progressPercent}%</span>
                        </div>
                      </td>
                      <td className="px-5 py-4 text-text-secondary">
                        {row.missingDocuments.length > 0 ? row.missingDocuments.join(", ") : "—"}
                      </td>
                      <td className="px-5 py-4 text-text-secondary">
                        {relativeTime(row.lastActivity)}
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={row.status as CollectionRequestStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
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
    business_type_suggestions: counts.businessTypeSuggestions,
    pending_confirmations: counts.pendingConfirmations,
  };

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        eyebrow={`שלום, ${session.organizationName}`}
        title="לוח הבקרה"
        description="תמונת מצב של העבודה הפעילה כרגע — לא רשימת כל הלקוחות."
      />

      <form action="/dashboard" method="GET" className="mb-8 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            name="q"
            type="text"
            defaultValue={q ?? ""}
            placeholder="חיפוש לקוח לפי שם או טלפון..."
            className="w-full rounded-xl border border-border bg-surface ps-10 pe-4 py-3 text-sm text-text-primary shadow-card outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
        </div>
        <button
          type="submit"
          className="rounded-xl border border-border bg-surface px-5 py-3 text-sm font-medium text-text-secondary shadow-card transition-all hover:border-brand-purple hover:text-brand-purple"
        >
          חיפוש
        </button>
      </form>

      {searchResults && (
        <Card className="mb-8 animate-fade-in-up" padding="sm">
          {searchResults.length === 0 ? (
            <p className="px-2 py-2 text-sm text-text-muted">לא נמצאו לקוחות תואמים.</p>
          ) : (
            <ul className="divide-y divide-border">
              {searchResults.map((client) => (
                <li key={client.id}>
                  <Link
                    href={`/clients/${client.id}`}
                    className="block rounded-lg px-3 py-2.5 text-sm text-text-primary transition-colors hover:bg-surface-muted hover:text-brand-purple"
                  >
                    {client.name} <span className="text-text-muted" dir="ltr">({client.phone})</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {QUEUE_CARDS.map(({ queue: cardQueue, label, icon: Icon, accent }) => {
          const { count, percentage } = countsByQueue[cardQueue];
          return (
            <KpiCard
              key={cardQueue}
              href={`/dashboard?queue=${cardQueue}`}
              label={label}
              value={count}
              percentage={percentage}
              icon={<Icon className="h-4.5 w-4.5" aria-hidden="true" />}
              accent={accent}
            />
          );
        })}
      </div>
    </div>
  );
}
