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
import { getOrganization } from "@/lib/data/organizations";
import {
  getDashboardCounts,
  listBusinessTypeSuggestions,
  listPendingConfirmationsForDashboard,
  listQueue,
  searchClients,
  type DashboardQueue,
} from "@/lib/data/dashboard";
import { OneTimeDashboard } from "./OneTimeDashboard";
import { StatusBadge } from "../collections/StatusBadge";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/app/KpiCard";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { AiBriefing, type AiBriefingAction } from "@/components/app/AiBriefing";
import { ProgressBar } from "@/components/app/ProgressBar";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";

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

// Rule-based headline composed from getDashboardCounts' own numbers — no
// live AI/LLM call. Priority: needs-review > pending-confirmations >
// classification-suggestions (things that need a human) > completed-today
// > active-only > all-clear.
function buildBriefing(counts: Awaited<ReturnType<typeof getDashboardCounts>>) {
  const needsAttention: string[] = [];
  if (counts.needsReview.count > 0) {
    needsAttention.push(`${counts.needsReview.count} דורשות בדיקת עובד`);
  }
  if (counts.pendingConfirmations.count > 0) {
    needsAttention.push(`${counts.pendingConfirmations.count} ממתינות לאישור לקוח`);
  }
  if (counts.businessTypeSuggestions.count > 0) {
    needsAttention.push(`${counts.businessTypeSuggestions.count} הצעות סיווג לקוחות ממתינות`);
  }

  if (needsAttention.length > 0) {
    const completedSuffix =
      counts.completedToday.count > 0 ? ` ${counts.completedToday.count} הושלמו היום.` : "";
    return `${needsAttention.join(", ")}.${completedSuffix}`;
  }

  if (counts.completedToday.count > 0) {
    return `הכול תחת שליטה — ${counts.completedToday.count} בקשות הושלמו היום ואין דבר שדורש תשומת לב.`;
  }

  if (counts.active.count > 0) {
    return `${counts.active.count} בקשות איסוף פעילות כרגע — אין דבר שדורש תשומת לב מיידית.`;
  }

  return "אין עבודה פעילה כרגע — הכול נקי ומעודכן.";
}

// The same "needs attention" priority order buildBriefing() already
// summarizes in prose, rendered as individually clickable chips. Every
// href here already exists on the KpiCard grid below — purely a visual
// shortcut onto existing navigation, not a new capability.
function buildBriefingActions(
  counts: Awaited<ReturnType<typeof getDashboardCounts>>
): AiBriefingAction[] {
  const actions: AiBriefingAction[] = [];
  if (counts.needsReview.count > 0) {
    actions.push({
      href: "/dashboard?queue=needs_review",
      label: "דורשות בדיקת עובד",
      count: counts.needsReview.count,
    });
  }
  if (counts.pendingConfirmations.count > 0) {
    actions.push({
      href: "/dashboard?queue=pending_confirmations",
      label: "ממתינות לאישור לקוח",
      count: counts.pendingConfirmations.count,
    });
  }
  if (counts.businessTypeSuggestions.count > 0) {
    actions.push({
      href: "/dashboard?queue=business_type_suggestions",
      label: "הצעות סיווג לקוחות",
      count: counts.businessTypeSuggestions.count,
    });
  }
  return actions;
}

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

  // Product Evolution M4 — the one shared route branches into a completely
  // different dashboard for a one-time-workflow organization. Everything
  // below this point (queues, business-type suggestions, pending
  // confirmations) is Workflow-A-only vocabulary that doesn't apply.
  const organization = await getOrganization(session.organizationId);
  if (organization?.workflowType === "one_time") {
    return <OneTimeDashboard organizationId={session.organizationId} />;
  }

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
          <Table>
            <TableHead>
              <TableHeadCell>לקוח</TableHeadCell>
              <TableHeadCell>סוג עסק מוצע</TableHeadCell>
              <TableHeadCell>ביטחון</TableHeadCell>
            </TableHead>
            <tbody>
              {suggestions.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/clients/${row.id}`}
                      className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                    >
                      {row.name}
                    </Link>
                    <p className="text-xs text-text-muted" dir="ltr">
                      {row.phone}
                    </p>
                  </TableCell>
                  <TableCell className="text-text-secondary">{row.businessTypeName ?? "—"}</TableCell>
                  <TableCell>
                    <Badge tone="warning">{row.confidence}%</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
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
          <Table>
            <TableHead>
              <TableHeadCell>לקוח</TableHeadCell>
              <TableHeadCell>שאלה</TableHeadCell>
              <TableHeadCell>נשלחה</TableHeadCell>
            </TableHead>
            <tbody>
              {pending.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/collections/${row.collectionRequestId}`}
                      className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                    >
                      {row.clientName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-text-secondary">{row.question}</TableCell>
                  <TableCell className="text-text-secondary">{relativeTime(row.createdAt)}</TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
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
          <Table minWidth={640}>
            <TableHead>
              <TableHeadCell>לקוח</TableHeadCell>
              <TableHeadCell>התקדמות</TableHeadCell>
              <TableHeadCell>מסמכים חסרים</TableHeadCell>
              <TableHeadCell>פעילות אחרונה</TableHeadCell>
              <TableHeadCell>סטטוס</TableHeadCell>
            </TableHead>
            <tbody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Link
                      href={`/collections/${row.id}`}
                      className="font-medium text-text-primary transition-colors hover:text-brand-purple"
                    >
                      {row.clientName}
                    </Link>
                    <p className="text-xs text-text-muted">
                      {row.serviceName} · {row.periodLabel}
                    </p>
                  </TableCell>
                  <TableCell>
                    <ProgressBar percent={row.progressPercent} showLabel />
                  </TableCell>
                  <TableCell className="text-text-secondary">
                    {row.missingDocuments.length > 0 ? row.missingDocuments.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-text-secondary">{relativeTime(row.lastActivity)}</TableCell>
                  <TableCell>
                    <StatusBadge status={row.status as CollectionRequestStatus} />
                  </TableCell>
                </TableRow>
              ))}
            </tbody>
          </Table>
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

  // Centro Glow's approved two-tier hierarchy: the single most urgent
  // queue (needs_review — same item buildBriefing() already puts first)
  // gets the large primary tile; every other queue stays a calm, equally-
  // weighted tile. Purely a presentational split of the same QUEUE_CARDS
  // list and countsByQueue map used before — no new data, no changed
  // hrefs, no changed queue semantics.
  const primaryCard = QUEUE_CARDS.find((c) => c.queue === "needs_review")!;
  const calmCards = QUEUE_CARDS.filter((c) => c.queue !== "needs_review");

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-6 py-10 lg:px-10">
      <PageHeader
        eyebrow={`שלום, ${session.organizationName}`}
        title="לוח הבקרה"
        description="תמונת מצב של העבודה הפעילה כרגע — לא רשימת כל הלקוחות."
      />

      <AiBriefing text={buildBriefing(counts)} actions={buildBriefingActions(counts)} />

      <form action="/dashboard" method="GET" className="mb-8 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            name="q"
            type="text"
            defaultValue={q ?? ""}
            placeholder="חיפוש לקוח לפי שם או טלפון..."
            className="centro-glass w-full rounded-xl border border-border ps-10 pe-4 py-3 text-sm text-text-primary shadow-card outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
          />
        </div>
        <button
          type="submit"
          className="centro-glass rounded-xl border border-border px-5 py-3 text-sm font-medium text-text-secondary shadow-card transition-all hover:border-brand-purple hover:text-brand-purple"
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

      <div className="grid grid-cols-1 gap-3.5 lg:grid-cols-[300px_1fr]">
        <KpiCard
          href={`/dashboard?queue=${primaryCard.queue}`}
          label={primaryCard.label}
          value={countsByQueue[primaryCard.queue].count}
          sub="הפריט הכי דחוף כרגע — כדאי להתחיל כאן"
          icon={<primaryCard.icon className="h-5 w-5" aria-hidden="true" />}
          accent={primaryCard.accent}
          variant="primary"
        />
        <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
          {calmCards.map(({ queue: cardQueue, label, icon: Icon, accent }) => {
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
    </div>
  );
}
