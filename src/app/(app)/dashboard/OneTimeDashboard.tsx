import Link from "next/link";
import { LayoutTemplate, Users, Activity, CheckCircle2, Plus, Sparkles } from "lucide-react";
import { CentroStatusIndicator } from "@/components/app/CentroStatusIndicator";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { AiBriefing } from "@/components/app/AiBriefing";
import { KpiCard } from "@/components/app/KpiCard";
import { TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { buttonVariants } from "@/components/app/Button";
import { StatusBadge } from "../collections/StatusBadge";
import {
  getOneTimeDashboardCounts,
  listRecentOneTimeRequests,
  shouldShowSampleTemplateCard,
} from "@/lib/data/oneTimeDashboard";

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

// Rule-based headline from getOneTimeDashboardCounts' own numbers — no
// live AI/LLM call. This workflow has no queues/classification, so the
// briefing is deliberately simpler than the recurring dashboard's.
function buildBriefing(counts: Awaited<ReturnType<typeof getOneTimeDashboardCounts>>) {
  if (counts.templateCount === 0) {
    return "עדיין אין תבניות מוגדרות — צרו תבנית ראשונה כדי להתחיל לשלוח בקשות איסוף.";
  }

  const parts: string[] = [];
  if (counts.activeRequestCount > 0) parts.push(`${counts.activeRequestCount} בקשות פעילות`);
  if (counts.completedThisWeekCount > 0) parts.push(`${counts.completedThisWeekCount} הושלמו השבוע`);

  if (parts.length === 0) {
    return "אין בקשות פעילות כרגע — הכול נקי ומעודכן.";
  }

  return `${parts.join(", ")}.`;
}

// Workflow B's own dashboard — a deliberately different, smaller surface
// than the recurring dashboard's queue-card system, since none of that
// vocabulary (business-type suggestions, pending classification
// confirmations, etc.) exists in this workflow. Reuses shared UI
// primitives (Card, EmptyState, StatusBadge) and the recurring dashboard's
// composition pattern, not its content.
export async function OneTimeDashboard({ organizationId }: { organizationId: string }) {
  const counts = await getOneTimeDashboardCounts(organizationId);
  const recentRequests = await listRecentOneTimeRequests(organizationId);
  const showSampleTemplateCard = await shouldShowSampleTemplateCard(organizationId);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[26px] font-bold tracking-tight text-text-primary">לוח בקרה</h1>
          <div className="flex shrink-0 items-center gap-3">
            <CentroStatusIndicator />
            <Link href="/templates" className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Plus className="h-4 w-4" />
              תבנית חדשה
            </Link>
          </div>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-text-secondary">
          בקשות איסוף מסמכים חד-פעמיות, לפי תבנית.
        </p>
      </div>

      <AiBriefing text={buildBriefing(counts)} />

      {showSampleTemplateCard && (
        <Link href="/templates">
          <Card
            interactive
            glow="purple"
            className="flex items-center gap-3 border-brand-purple/25 bg-brand-purple/5"
          >
            <span className="centro-icon-purple grid h-10 w-10 shrink-0 place-items-center rounded-xl">
              <Sparkles className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold text-text-primary">הכנו לכם תבנית לדוגמה</p>
              <p className="text-xs text-text-muted">
                כדי שתראו איך זה עובד — אפשר לערוך אותה או להתחיל תבנית משלכם. לחצו כדי לצפות
                בתבניות.
              </p>
            </div>
          </Card>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KpiCard
          label="תבניות"
          value={counts.templateCount}
          icon={<LayoutTemplate className="h-4.5 w-4.5" aria-hidden="true" />}
          accent="purple"
        />
        <KpiCard
          label="לקוחות"
          value={counts.clientCount}
          icon={<Users className="h-4.5 w-4.5" aria-hidden="true" />}
          accent="blue"
        />
        <KpiCard
          label="בקשות פעילות"
          value={counts.activeRequestCount}
          icon={<Activity className="h-4.5 w-4.5" aria-hidden="true" />}
          accent="cyan"
        />
        <KpiCard
          label="הושלמו השבוע"
          value={counts.completedThisWeekCount}
          icon={<CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" />}
          accent="emerald"
        />
      </div>

      {counts.templateCount === 0 ? (
        <EmptyState
          icon={LayoutTemplate}
          title="עדיין אין תבניות"
          description="תבנית מגדירה אילו מסמכים לבקש ומאיזה לקוחות — ואפשר לשלוח אותה שוב ושוב. צרו תבנית ראשונה כדי להתחיל."
          action={
            <Link href="/templates" className={buttonVariants({ variant: "primary", size: "sm" })}>
              יצירת תבנית ראשונה
            </Link>
          }
        />
      ) : (
        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold text-text-primary">בקשות אחרונות</h2>
          </div>
          {recentRequests.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-text-muted">
              עדיין לא נשלחו בקשות. שלחו תבנית ללקוח כדי להתחיל.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[480px] text-end text-sm">
                <TableHead>
                  <TableHeadCell>לקוח</TableHeadCell>
                  <TableHeadCell>תבנית</TableHeadCell>
                  <TableHeadCell>סטטוס</TableHeadCell>
                  <TableHeadCell>נשלח</TableHeadCell>
                </TableHead>
                <tbody>
                  {recentRequests.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium text-text-primary">{row.clientName}</TableCell>
                      <TableCell className="text-text-secondary">{row.templateName}</TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} />
                      </TableCell>
                      <TableCell className="text-text-muted">{relativeTime(row.createdAt)}</TableCell>
                    </TableRow>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
