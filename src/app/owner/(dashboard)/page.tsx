import {
  Building2,
  Activity,
  ClipboardList,
  DollarSign,
} from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getOwnerHomeMetrics } from "@/lib/data/owner/metrics";
import { getOnboardingFunnel } from "@/lib/data/owner/funnel";
import { listRecentActivity } from "@/lib/data/owner/activity";
import { getOwnerHealthSignals } from "@/lib/data/owner/health";
import { getAiUsageToday } from "@/lib/data/owner/aiUsage";
import { computeHealthStatus } from "@/lib/owner/health";
import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/app/KpiCard";
import { Card } from "@/components/app/Card";
import { OwnerFunnelChart } from "@/components/owner/OwnerFunnelChart";
import { OwnerAutoRefresh } from "@/components/owner/OwnerAutoRefresh";
import { OwnerCurrencyKpiCard } from "@/components/owner/OwnerCurrencyKpiCard";
import { OwnerSystemBanner } from "@/components/owner/OwnerSystemBanner";
import { CollapsibleSection } from "@/components/owner/CollapsibleSection";
import { ActivityFeed } from "@/components/owner/ActivityFeed";
import { t } from "@/lib/owner/i18n/t";

const AI_COST_FORMATTER = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

// Secondary daily counters. Kept in full — none of these were removed,
// they simply stopped competing with the four numbers that answer "what is
// the state of the system right now". A metric sitting at 0 is rendered as
// a quiet row rather than a full card, so an empty day reads as calm
// instead of as twelve zeroes.
function DailyMetric({ label, value }: { label: string; value: string | number }) {
  const isZero = value === 0 || value === "0";
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 text-sm last:border-b-0">
      <span className={isZero ? "text-text-muted" : "text-text-secondary"}>{label}</span>
      <span
        className={`font-semibold tabular-nums ${isZero ? "text-text-muted" : "text-text-primary"}`}
      >
        {value}
      </span>
    </div>
  );
}

export default async function OwnerHomePage() {
  await requireOwnerSession();

  const [metrics, funnel, activity, healthSignals, aiCostsToday] = await Promise.all([
    getOwnerHomeMetrics(),
    getOnboardingFunnel(),
    listRecentActivity(),
    getOwnerHealthSignals(),
    getAiUsageToday(),
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

  const dailyMetrics = [
    { label: t("owner.home.kpi.newToday"), value: metrics.newOrganizationsToday },
    { label: t("owner.home.kpi.newThisMonth"), value: metrics.newOrganizationsThisMonth },
    { label: t("owner.home.kpi.completedRequests"), value: metrics.completedCollectionRequests },
    { label: t("owner.home.kpi.failedRequests"), value: metrics.failedCollectionRequests },
    { label: t("owner.home.kpi.documentsToday"), value: metrics.documentsProcessedToday },
    { label: t("owner.home.kpi.aiMessagesToday"), value: metrics.aiMessagesToday },
    { label: t("owner.home.kpi.whatsappMessagesToday"), value: metrics.whatsappMessagesToday },
    { label: t("owner.home.kpi.driveUploadsToday"), value: metrics.driveUploadsToday },
  ];
  const allDailyZero = dailyMetrics.every((metric) => metric.value === 0);

  return (
    <div>
      <OwnerAutoRefresh />
      <PageHeader
        eyebrow={t("owner.home.eyebrow")}
        title={t("owner.home.pageTitle")}
        description={t("owner.home.pageDescription")}
      />

      <OwnerSystemBanner status={health} />

      {/* The four that answer "what is the state of the system". */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
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
          label={t("owner.home.kpi.openRequests")}
          value={metrics.openCollectionRequests}
          icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}
          accent="blue"
        />
        <OwnerCurrencyKpiCard
          label={t("owner.home.kpi.aiCostToday")}
          formattedValue={AI_COST_FORMATTER.format(aiCostsToday.totalEstimatedCostUsd)}
          approximate={aiCostsToday.hasUnpricedModels}
          icon={<DollarSign className="h-4 w-4" aria-hidden="true" />}
          accent="warning"
        />
      </div>

      <div className="mt-4 space-y-3">
        <CollapsibleSection
          title="נתוני היום"
          subtitle={allDailyZero ? "אין פעילות היום עדיין" : undefined}
        >
          {allDailyZero ? (
            <p className="text-sm text-text-muted">אין פעילות היום עדיין.</p>
          ) : (
            <div>
              {dailyMetrics.map((metric) => (
                <DailyMetric key={metric.label} label={metric.label} value={metric.value} />
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection title={t("owner.home.funnelTitle")}>
          <OwnerFunnelChart stages={funnelStages} />
        </CollapsibleSection>

        <CollapsibleSection
          title={t("owner.home.activityTitle")}
          subtitle={activity.length === 0 ? "אין פעילות אחרונה" : `${activity.length} אירועים אחרונים`}
        >
          <Card padding="none" className="max-h-[460px] overflow-y-auto px-5 py-3">
            <ActivityFeed events={activity} emptyTitle={t("owner.home.activityEmpty")} />
          </Card>
        </CollapsibleSection>
      </div>
    </div>
  );
}
