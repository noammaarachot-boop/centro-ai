import Link from "next/link";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Clock, Activity, ArrowRight, FolderKanban, Plus } from "lucide-react";
import { CentroStatusIndicator } from "@/components/app/CentroStatusIndicator";
import { Card } from "@/components/app/Card";
import { EmptyState } from "@/components/app/EmptyState";
import { KpiCard } from "@/components/app/KpiCard";
import { PageHeader } from "@/components/app/PageHeader";
import { TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { buttonVariants } from "@/components/app/Button";
import { describeRequestLine } from "@/lib/requestLabel";
import { StatusBadge } from "../collections/StatusBadge";
import {
  getOneTimeDashboardView,
  listActiveRequestsFull,
  listCompletedThisWeekFull,
  listNeedsReviewRequests,
  type NeedsAttentionRow,
  type OneTimeDashboardView,
} from "@/lib/data/oneTimeDashboardView";
import { DismissAttentionButton } from "@/components/app/DismissAttentionButton";
import { dismissAttentionItem } from "./attentionActions";

// The three KPI tiles' own real drill-down targets (issue: every KPI card
// used to point at /collections — the template gallery — regardless of
// which tile was clicked, an operational dead end for a dashboard whose
// job is drill-down, not navigation to template management). One value
// per tile, used both as the query param and as the switch key below.
type DashboardKpi = "needs_review" | "active" | "completed_this_week";

const KPI_TITLES: Record<DashboardKpi, string> = {
  needs_review: "דורש בדיקה",
  active: "בקשות איסוף פעילות",
  completed_this_week: "הושלמו השבוע",
};

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

// Dynamic summary hero — state A ("attention": one or more real
// needs-review items exist) vs state B ("calm": none do). Every number and
// phrase here is pre-composed by oneTimeDashboardView.ts from the same
// getItemsNeedingReview() the KPI tile and the priority list below also
// use — never a separate count computed here.
function DashboardHero({ hero }: { hero: OneTimeDashboardView["hero"] }) {
  const isCalm = hero.state === "calm";
  return (
    <div className="centro-glass-strong relative mb-8 overflow-hidden rounded-[24px] border border-border p-8 shadow-card-lg sm:p-9">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-x-[6%] -inset-y-[22%] -z-10 blur-[24px]"
        style={{
          background: isCalm
            ? "radial-gradient(55% 90% at 15% 30%, color-mix(in oklab, var(--color-brand-emerald) 14%, transparent), transparent 72%), radial-gradient(40% 70% at 85% 80%, color-mix(in oklab, var(--color-brand-cyan) 10%, transparent), transparent 74%)"
            : "radial-gradient(55% 90% at 15% 30%, color-mix(in oklab, var(--color-danger) 14%, transparent), transparent 72%), radial-gradient(40% 70% at 85% 80%, color-mix(in oklab, var(--color-brand-purple) 12%, transparent), transparent 74%)",
        }}
      />
      <h2 className="max-w-[58ch] text-xl leading-relaxed font-bold text-text-primary sm:text-[23px]">
        {hero.headline}
      </h2>
      {hero.subtext && <p className="mt-2 max-w-[62ch] text-sm text-text-secondary">{hero.subtext}</p>}
      {hero.chips.length > 0 && (
        <div className="mt-5 flex flex-wrap gap-2.5">
          {hero.chips.map((chip) => (
            <Link
              key={chip.label}
              href={chip.href}
              className="inline-flex items-center gap-2.5 rounded-full border border-border bg-surface px-4 py-2.5 text-[13.5px] font-semibold text-text-primary shadow-card transition-all duration-200 ease-[var(--ease-standard)] hover:-translate-y-0.5"
            >
              <span
                className={clsx(
                  "inline-grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[11px] font-extrabold text-white",
                  chip.tone === "danger" ? "bg-danger" : "bg-warning"
                )}
              >
                {chip.count}
              </span>
              {chip.label}
              <span className="text-text-muted" aria-hidden="true">←</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// The row list itself — shared between the homepage's own capped section
// and the "דורש בדיקה" KPI's full drill-down page below, so the two are
// never differently-shaped renderings of the same getItemsNeedingReview()
// data.
function NeedsAttentionRows({ rows }: { rows: NeedsAttentionRow[] }) {
  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => (
        <div
          key={row.collectionRequestId}
          className={clsx(
            "centro-glass flex items-center gap-4 rounded-2xl border border-border p-4 shadow-card",
            row.severity === "danger" ? "border-s-4 border-s-danger" : "border-s-4 border-s-warning"
          )}
        >
          <span
            className={clsx(
              "grid h-9.5 w-9.5 shrink-0 place-items-center rounded-xl",
              row.severity === "danger" ? "centro-icon-danger" : "centro-icon-warning"
            )}
          >
            {row.severity === "danger" ? (
              <Clock className="h-4.5 w-4.5" aria-hidden="true" />
            ) : (
              <AlertTriangle className="h-4.5 w-4.5" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold text-text-primary">{row.title}</p>
            <p className="mt-0.5 truncate text-[12.5px] text-text-secondary">{row.meta}</p>
          </div>
          <Link
            href={row.actionHref}
            className="shrink-0 rounded-lg border border-border bg-surface-muted px-3.5 py-2 text-[12.5px] font-bold whitespace-nowrap text-text-primary"
          >
            {row.actionLabel} ←
          </Link>
          {/* Marks THIS occurrence as handled. Nothing about the request,
              its documents or its status changes — an item that resolves
              itself (the request completes, the client answers) already
              disappears on its own; this is only for the case where a human
              dealt with it out of band and the condition legitimately
              still stands. */}
          <DismissAttentionButton
            action={dismissAttentionItem.bind(null, row.collectionRequestId, row.reasonKind, row.sourceId)}
          />
        </div>
      ))}
    </div>
  );
}

function NeedsAttentionSection({ rows }: { rows: OneTimeDashboardView["needsAttention"] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-8">
      <div className="mb-3.5 flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-[17px] font-bold text-text-primary">
          מחכה לטיפול שלך
          <span className="inline-grid h-[22px] min-w-[22px] place-items-center rounded-full bg-danger px-1.5 text-xs font-extrabold text-white">
            {rows.length}
          </span>
        </h2>
        <Link href="/dashboard?kpi=needs_review" className="text-sm font-semibold text-brand-purple">
          הצג הכול ←
        </Link>
      </div>
      <NeedsAttentionRows rows={rows} />
    </div>
  );
}

function InProgressTable({ rows }: { rows: OneTimeDashboardView["inProgress"] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FolderKanban}
        title="אין בקשות בתהליך כרגע"
        description="ברגע שתשלחו בקשת איסוף ללקוח, היא תופיע כאן."
        action={
          <Link href="/collections/new" className={buttonVariants({ variant: "primary", size: "sm" })}>
            יצירת בקשת איסוף
          </Link>
        }
      />
    );
  }

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-end text-sm">
          <TableHead>
            <TableHeadCell>לקוח</TableHeadCell>
            <TableHeadCell>בקשת איסוף</TableHeadCell>
            <TableHeadCell>התקדמות</TableHeadCell>
            <TableHeadCell>מצב נוכחי</TableHeadCell>
            <TableHeadCell>עדכון אחרון</TableHeadCell>
            <TableHeadCell>{" "}</TableHeadCell>
          </TableHead>
          <tbody>
            {rows.map((row) => {
              const percent = row.totalCount === 0 ? 100 : Math.round((row.satisfiedCount / row.totalCount) * 100);
              return (
                <TableRow key={row.collectionRequestId}>
                  <TableCell className="font-medium text-text-primary">{row.clientName}</TableCell>
                  {/* One line, said once. The period label is derived from
                      the service name, so printing both repeated it. */}
                  <TableCell className="text-text-secondary">
                    {describeRequestLine(row.serviceName, row.periodLabel)}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-muted">
                        <div
                          className="h-full rounded-full bg-gradient-to-l from-brand-blue to-brand-cyan"
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="text-xs whitespace-nowrap text-text-muted tabular-nums">
                        {row.satisfiedCount}/{row.totalCount}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                  </TableCell>
                  <TableCell className="text-text-muted">{row.lastActivityLabel}</TableCell>
                  <TableCell>
                    <Link href={row.href} className="text-[12.5px] font-bold text-brand-purple">
                      פתיחה
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// A KPI tile's own drill-down page — operational detail, not navigation
// to template management (/collections is the template gallery, a
// different screen entirely). Each of the three real lists below already
// carries everything a row needs to act on: client, template/service +
// period, status, progress (what's received vs. still missing), last
// activity, and a link into /collections/[id] — the real command-center
// page — for the full picture (documents, thread, audit).
async function KpiDrillDownPage({ organizationId, kpi }: { organizationId: string; kpi: DashboardKpi }) {
  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up px-4 py-10 sm:px-6 lg:px-10">
      <Link
        href="/dashboard"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-text-muted transition-colors hover:text-brand-purple"
      >
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
        חזרה ללוח הבקרה
      </Link>
      <PageHeader title={KPI_TITLES[kpi]} />

      {kpi === "needs_review" ? (
        <NeedsReviewDrillDown organizationId={organizationId} />
      ) : kpi === "active" ? (
        <ActiveRequestsDrillDown organizationId={organizationId} />
      ) : (
        <CompletedThisWeekDrillDown organizationId={organizationId} />
      )}
    </div>
  );
}

async function NeedsReviewDrillDown({ organizationId }: { organizationId: string }) {
  const rows = await listNeedsReviewRequests(organizationId);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="אין דבר שדורש בדיקה כרגע"
        description="ברגע שמשהו יצריך את תשומת לבך — מסמך לבדיקה, שאלת לקוח, בקשה שהוסלמה — הוא יופיע כאן."
      />
    );
  }
  return <NeedsAttentionRows rows={rows} />;
}

async function ActiveRequestsDrillDown({ organizationId }: { organizationId: string }) {
  const rows = await listActiveRequestsFull(organizationId);
  return <InProgressTable rows={rows} />;
}

async function CompletedThisWeekDrillDown({ organizationId }: { organizationId: string }) {
  const rows = await listCompletedThisWeekFull(organizationId);
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        title="עדיין לא הושלמו בקשות השבוע"
        description="בקשות שיושלמו בשבעת הימים האחרונים יופיעו כאן."
      />
    );
  }
  return <InProgressTable rows={rows} />;
}

// Workflow B's own dashboard — a deliberately different, smaller surface
// than the recurring dashboard's queue-card system. Every KPI, priority-
// list row, and table row here is a direct rendering of
// getOneTimeDashboardView()'s already-computed view props — this
// component makes no completion/status/review decisions of its own.
export async function OneTimeDashboard({ organizationId, kpi }: { organizationId: string; kpi?: string }) {
  if (kpi === "needs_review" || kpi === "active" || kpi === "completed_this_week") {
    return <KpiDrillDownPage organizationId={organizationId} kpi={kpi} />;
  }

  const view = await getOneTimeDashboardView(organizationId);

  return (
    <div className="mx-auto max-w-5xl animate-fade-in-up space-y-6 px-4 py-10 sm:px-6 lg:px-10">
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
          כל מה שקורה עם הלקוחות שלך, במקום אחד — תמיד מעודכן.
        </p>
      </div>

      {!view.hasSentAnyRequest ? (
        <FirstSendFocalCard draftId={view.draftId} />
      ) : (
        <>
          <DashboardHero hero={view.hero} />

          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard
              href="/dashboard?kpi=needs_review"
              label="דורש בדיקה"
              value={view.kpis.needsReviewCount}
              icon={<AlertTriangle className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="danger"
            />
            <KpiCard
              href="/dashboard?kpi=active"
              label="בקשות פעילות"
              value={view.kpis.activeRequestsCount}
              icon={<Activity className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="cyan"
            />
            <KpiCard
              href="/dashboard?kpi=completed_this_week"
              label="הושלמו השבוע"
              value={view.kpis.completedThisWeekCount}
              icon={<CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" />}
              accent="emerald"
            />
          </div>

          <NeedsAttentionSection rows={view.needsAttention} />

          <div className="mb-3.5 flex items-baseline justify-between">
            <h2 className="text-[17px] font-bold text-text-primary">בקשות בתהליך</h2>
            <Link href="/dashboard?kpi=active" className="text-sm font-semibold text-brand-purple">
              כל הבקשות ←
            </Link>
          </div>
          <InProgressTable rows={view.inProgress} />
        </>
      )}
    </div>
  );
}
