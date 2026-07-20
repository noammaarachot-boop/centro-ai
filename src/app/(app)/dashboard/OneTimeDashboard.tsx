import Link from "next/link";
import { LayoutTemplate, Users, Activity, CheckCircle2, Plus } from "lucide-react";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { buttonVariants } from "@/components/app/Button";
import { StatusBadge } from "../collections/StatusBadge";
import {
  getOneTimeDashboardCounts,
  listRecentOneTimeRequests,
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

function StatTile({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: number;
}) {
  return (
    <Card className="flex items-center gap-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-purple/10 text-brand-purple">
        <Icon className="h-5 w-5" />
      </span>
      <div>
        <p className="text-2xl font-bold tabular-nums text-text-primary">{value}</p>
        <p className="text-xs text-text-muted">{label}</p>
      </div>
    </Card>
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

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        title="לוח בקרה"
        description="בקשות איסוף מסמכים חד-פעמיות, לפי תבנית."
        actions={
          <Link href="/templates" className={buttonVariants({ variant: "primary", size: "sm" })}>
            <Plus className="h-4 w-4" />
            תבנית חדשה
          </Link>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile icon={LayoutTemplate} label="תבניות" value={counts.templateCount} />
        <StatTile icon={Users} label="לקוחות" value={counts.clientCount} />
        <StatTile icon={Activity} label="בקשות פעילות" value={counts.activeRequestCount} />
        <StatTile
          icon={CheckCircle2}
          label="הושלמו השבוע"
          value={counts.completedThisWeekCount}
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
                <thead className="sticky top-0 bg-surface-muted text-text-muted">
                  <tr>
                    <th className="px-5 py-3.5 font-medium">לקוח</th>
                    <th className="px-5 py-3.5 font-medium">תבנית</th>
                    <th className="px-5 py-3.5 font-medium">סטטוס</th>
                    <th className="px-5 py-3.5 font-medium">נשלח</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRequests.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-border transition-colors hover:bg-surface-muted/60"
                    >
                      <td className="px-5 py-4 font-medium text-text-primary">{row.clientName}</td>
                      <td className="px-5 py-4 text-text-secondary">{row.templateName}</td>
                      <td className="px-5 py-4">
                        <StatusBadge status={row.status} />
                      </td>
                      <td className="px-5 py-4 text-text-muted">{relativeTime(row.createdAt)}</td>
                    </tr>
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
