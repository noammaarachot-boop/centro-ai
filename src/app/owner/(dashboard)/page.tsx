import {
  Building2,
  Activity,
  CalendarPlus,
  CalendarDays,
  ClipboardList,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Sparkles,
  MessageCircle,
  HardDrive,
  History,
  DollarSign,
} from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getOwnerHomeMetrics } from "@/lib/data/owner/metrics";
import { getOnboardingFunnel } from "@/lib/data/owner/funnel";
import { listRecentActivity } from "@/lib/data/owner/activity";
import { getOwnerHealthSignals } from "@/lib/data/owner/health";
import { getOwnerAiCostsToday } from "@/lib/data/owner/costs";
import { computeHealthStatus } from "@/lib/owner/health";
import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/app/KpiCard";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { OwnerFunnelChart } from "@/components/owner/OwnerFunnelChart";
import { OwnerAutoRefresh } from "@/components/owner/OwnerAutoRefresh";
import { OwnerHealthBadge } from "@/components/owner/OwnerHealthBadge";
import { OwnerCurrencyKpiCard } from "@/components/owner/OwnerCurrencyKpiCard";
import { formatOwnerDateTime } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";

const AI_COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export default async function OwnerHomePage() {
  await requireOwnerSession();

  const [metrics, funnel, activity, healthSignals, aiCostsToday] = await Promise.all([
    getOwnerHomeMetrics(),
    getOnboardingFunnel(),
    listRecentActivity(),
    getOwnerHealthSignals(),
    getOwnerAiCostsToday(),
  ]);
  const health = computeHealthStatus(healthSignals);

  const funnelStages = [
    { label: t("owner.home.funnel.registered"), value: funnel.registered },
    { label: t("owner.home.funnel.completedOnboarding"), value: funnel.completedOnboarding },
    { label: t("owner.home.funnel.connectedWhatsapp"), value: funnel.connectedWhatsapp },
    { label: t("owner.home.funnel.connectedDrive"), value: funnel.connectedDrive },
    { label: t("owner.home.funnel.createdFirstRequest"), value: funnel.createdFirstRequest },
    { label: t("owner.home.funnel.completedFirstRequest"), value: funnel.completedFirstRequest },
  ];

  return (
    <div>
      <OwnerAutoRefresh />
      <PageHeader
        eyebrow={t("owner.home.eyebrow")}
        title={t("owner.home.pageTitle")}
        description={t("owner.home.pageDescription")}
        actions={<OwnerHealthBadge status={health} />}
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        <KpiCard
          href="/owner/organizations"
          label={t("owner.home.kpi.totalOrganizations")}
          value={metrics.totalOrganizations}
          icon={<Building2 className="h-4 w-4" aria-hidden="true" />}
          accent="purple"
        />
        <KpiCard
          label={t("owner.home.kpi.activeOrganizations")}
          value={metrics.activeOrganizations}
          icon={<Activity className="h-4 w-4" aria-hidden="true" />}
          accent="emerald"
        />
        <KpiCard
          label={t("owner.home.kpi.newToday")}
          value={metrics.newOrganizationsToday}
          icon={<CalendarPlus className="h-4 w-4" aria-hidden="true" />}
          accent="blue"
        />
        <KpiCard
          label={t("owner.home.kpi.newThisMonth")}
          value={metrics.newOrganizationsThisMonth}
          icon={<CalendarDays className="h-4 w-4" aria-hidden="true" />}
          accent="cyan"
        />
        <KpiCard
          label={t("owner.home.kpi.openRequests")}
          value={metrics.openCollectionRequests}
          icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}
          accent="blue"
        />
        <KpiCard
          label={t("owner.home.kpi.completedRequests")}
          value={metrics.completedCollectionRequests}
          icon={<CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
          accent="emerald"
        />
        <KpiCard
          label={t("owner.home.kpi.failedRequests")}
          value={metrics.failedCollectionRequests}
          icon={<AlertTriangle className="h-4 w-4" aria-hidden="true" />}
          accent="warning"
        />
        <KpiCard
          label={t("owner.home.kpi.documentsToday")}
          value={metrics.documentsProcessedToday}
          icon={<FileText className="h-4 w-4" aria-hidden="true" />}
          accent="purple"
        />
        <KpiCard
          label={t("owner.home.kpi.aiMessagesToday")}
          value={metrics.aiMessagesToday}
          icon={<Sparkles className="h-4 w-4" aria-hidden="true" />}
          accent="purple"
        />
        <OwnerCurrencyKpiCard
          label={t("owner.home.kpi.aiCostToday")}
          formattedValue={AI_COST_FORMATTER.format(aiCostsToday.totalEstimatedCostUsd)}
          approximate={aiCostsToday.hasRowsWithUnknownPricing}
          icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          accent="warning"
        />
        <KpiCard
          label={t("owner.home.kpi.whatsappMessagesToday")}
          value={metrics.whatsappMessagesToday}
          icon={<MessageCircle className="h-4 w-4" aria-hidden="true" />}
          accent="emerald"
        />
        <KpiCard
          label={t("owner.home.kpi.driveUploadsToday")}
          value={metrics.driveUploadsToday}
          icon={<HardDrive className="h-4 w-4" aria-hidden="true" />}
          accent="blue"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-bold text-text-primary">{t("owner.home.funnelTitle")}</h2>
          <OwnerFunnelChart stages={funnelStages} />
        </Card>

        <div>
          <h2 className="mb-3 text-sm font-bold text-text-primary">{t("owner.home.activityTitle")}</h2>
          {activity.length === 0 ? (
            <EmptyState icon={History} title={t("owner.home.activityEmpty")} />
          ) : (
            <Card padding="none" className="max-h-[420px] divide-y divide-border overflow-y-auto">
              {activity.map((event) => (
                <div key={event.id} className="flex items-start justify-between gap-4 px-5 py-3.5 text-sm">
                  <div>
                    <p className="font-medium text-text-primary">{event.description}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className="text-xs text-text-muted">{event.eventType}</span>
                      {event.organizationName && (
                        <Badge tone="neutral">{event.organizationName}</Badge>
                      )}
                      {event.source === "owner" && (
                        <Badge tone="purple">{t("owner.home.activityOwnerBadge")}</Badge>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-xs text-text-muted">
                    {formatOwnerDateTime(event.occurredAt)}
                  </span>
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
