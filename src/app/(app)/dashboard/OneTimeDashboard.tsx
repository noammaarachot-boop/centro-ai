import Link from "next/link";
import { FolderKanban, Users, Activity, CheckCircle2, Plus } from "lucide-react";
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
} from "@/lib/data/oneTimeDashboard";
import { resolveOnDemandDraft, hasSentAnyOnDemandRequest } from "@/lib/data/collectionRequestDrafts";

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
    return "עדיין אין בקשות איסוף מוגדרות — צרו את הבקשה הראשונה כדי להתחיל לשלוח.";
  }

  const parts: string[] = [];
  if (counts.activeRequestCount > 0) parts.push(`${counts.activeRequestCount} בקשות פעילות`);
  if (counts.completedThisWeekCount > 0) parts.push(`${counts.completedThisWeekCount} הושלמו השבוע`);

  if (parts.length === 0) {
    return "אין בקשות פעילות כרגע — הכול נקי ומעודכן.";
  }

  return `${parts.join(", ")}.`;
}

// First-Send Journey — the two-state focal card from the locked design:
// "Create" before any Collection Request definition exists at all,
// "Continue" once one exists but was never actually sent (see
// resolveOnDemandDraft's own comment for why that signal needs no new
// schema column). Once the org has sent at least one, this card disappears
// permanently and the dashboard below reverts to its normal KPI view —
// redesigning that returning-user view is explicitly out of this
// project's scope.
function FirstSendFocalCard({ draftId }: { draftId: string | null }) {
  const href = draftId ? `/collections/new?draft=${draftId}` : "/collections/new";
  return (
    <Link href={href}>
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-l from-brand-purple to-brand-blue p-8 text-center text-white shadow-card-lg transition-transform hover:-translate-y-0.5">
        <p className="mb-1.5 text-xs font-bold tracking-wide text-white/75 uppercase">השלב הראשון שלכם</p>
        <h2 className="text-xl font-bold">
          {draftId ? "השלימו את בקשת האיסוף הראשונה שלכם" : "צרו את בקשת האיסוף הראשונה שלכם"}
        </h2>
        <p className="mx-auto mt-2 max-w-sm text-sm text-white/85">
          {draftId
            ? "חזרו בדיוק למקום שבו עצרתם."
            : "תוך כמה דקות תוכלו לבקש מסמכים מלקוח — Centro ידאג להמשך."}
        </p>
        <span className={buttonVariants({ variant: "secondary", size: "md", className: "mt-5 bg-white text-brand-purple hover:bg-white/90" })}>
          {draftId ? "המשך" : "יצירת בקשת איסוף"}
        </span>
      </div>
    </Link>
  );
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
  const hasSent = await hasSentAnyOnDemandRequest(organizationId);
  const draftId = hasSent ? null : await resolveOnDemandDraft(organizationId);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <div className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-[26px] font-bold tracking-tight text-text-primary">לוח בקרה</h1>
          <div className="flex shrink-0 items-center gap-3">
            <CentroStatusIndicator />
            <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
              <Plus className="h-4 w-4" />
              בקשת איסוף חדשה
            </Link>
          </div>
        </div>
        <p className="mt-1.5 max-w-2xl text-sm text-text-secondary">
          בקשות איסוף מסמכים חד-פעמיות, נשלחות בכל עת.
        </p>
      </div>

      {!hasSent ? (
        <FirstSendFocalCard draftId={draftId} />
      ) : (
        <>
          <AiBriefing text={buildBriefing(counts)} />

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiCard
              href="/collections"
              label="בקשות מוגדרות"
              value={counts.templateCount}
              icon={<FolderKanban className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="purple"
            />
            <KpiCard
              href="/clients"
              label="לקוחות"
              value={counts.clientCount}
              icon={<Users className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="blue"
            />
            <KpiCard
              href="/collections"
              label="בקשות פעילות"
              value={counts.activeRequestCount}
              icon={<Activity className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="cyan"
            />
            <KpiCard
              href="/collections"
              label="הושלמו השבוע"
              value={counts.completedThisWeekCount}
              icon={<CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="emerald"
            />
          </div>

          {recentRequests.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title="עדיין לא נשלחו בקשות"
              description="שלחו בקשת איסוף ללקוח כדי להתחיל."
              action={
                <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
                  יצירת בקשת איסוף
                </Link>
              }
            />
          ) : (
            <Card padding="none" className="overflow-hidden">
              <div className="border-b border-border px-5 py-4">
                <h2 className="text-sm font-semibold text-text-primary">בקשות אחרונות</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-end text-sm">
                  <TableHead>
                    <TableHeadCell>לקוח</TableHeadCell>
                    <TableHeadCell>בקשת איסוף</TableHeadCell>
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
            </Card>
          )}
        </>
      )}
    </div>
  );
}
