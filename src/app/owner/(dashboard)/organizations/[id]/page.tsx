import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Users, ClipboardList, ListChecks, History } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getOrganizationOverview } from "@/lib/data/owner/organizations";
import { listAuditLog } from "@/lib/data/auditLog";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { KpiCard } from "@/components/app/KpiCard";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { formatOwnerDate, formatOwnerDateTime } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = { title: "פרטי ארגון — מסוף בעלים" };

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 text-sm last:border-b-0">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text-primary">{value}</span>
    </div>
  );
}

export default async function OwnerOrganizationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireOwnerSession();
  const { id } = await params;

  const overview = await getOrganizationOverview(id);
  if (!overview) notFound();

  const activity = await listAuditLog(id, {}, 50);

  return (
    <div>
      <Link
        href="/owner/organizations"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary transition-colors hover:text-brand-purple"
      >
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
        {t("owner.orgDetail.backLink")}
      </Link>

      <PageHeader
        title={overview.name?.trim() || t("owner.organizations.unnamed")}
        description={overview.userEmail ?? undefined}
        actions={
          <Badge tone={overview.onboardingCompletedAt ? "success" : "warning"} dot>
            {overview.onboardingCompletedAt
              ? t("owner.organizations.onboarding.complete")
              : t("owner.organizations.onboarding.incomplete")}
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <KpiCard
          label={t("owner.orgDetail.stats.clients")}
          value={overview.clientCount}
          icon={<Users className="h-4 w-4" aria-hidden="true" />}
          accent="blue"
        />
        <KpiCard
          label={t("owner.orgDetail.stats.collectionRequests")}
          value={overview.collectionRequestCount}
          icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}
          accent="purple"
        />
        <KpiCard
          label={t("owner.orgDetail.stats.openRequests")}
          value={overview.openCollectionRequestCount}
          icon={<ListChecks className="h-4 w-4" aria-hidden="true" />}
          accent="cyan"
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-2 text-sm font-bold text-text-primary">
            {t("owner.orgDetail.infoTitle")}
          </h2>
          <InfoRow label={t("owner.orgDetail.field.email")} value={overview.userEmail ?? t("owner.orgDetail.field.notProvided")} />
          <InfoRow label={t("owner.orgDetail.field.phone")} value={overview.userPhone ?? t("owner.orgDetail.field.notProvided")} />
          <InfoRow label={t("owner.orgDetail.field.fullName")} value={overview.userFullName ?? t("owner.orgDetail.field.notProvided")} />
          <InfoRow label={t("owner.orgDetail.field.createdAt")} value={formatOwnerDate(overview.createdAt)} />
          <InfoRow
            label={t("owner.orgDetail.field.workflowType")}
            value={
              overview.workflowType === "one_time"
                ? t("owner.organizations.workflowType.oneTime")
                : t("owner.organizations.workflowType.recurring")
            }
          />
          <InfoRow
            label={t("owner.orgDetail.field.businessCategory")}
            value={overview.businessCategoryCustomLabel ?? overview.businessCategory}
          />
        </Card>

        <Card>
          <h2 className="mb-2 text-sm font-bold text-text-primary">
            {t("owner.orgDetail.integrationsTitle")}
          </h2>
          <div className="flex items-center justify-between gap-4 border-b border-border py-2.5 text-sm">
            <span className="text-text-muted">{t("owner.orgDetail.integration.whatsapp")}</span>
            {overview.whatsappConnectedAt ? (
              <Badge tone="success" dot>
                {t("owner.orgDetail.integration.connectedAt", {
                  date: formatOwnerDate(overview.whatsappConnectedAt),
                })}
              </Badge>
            ) : (
              <Badge tone="neutral">{t("owner.orgDetail.integration.notConnected")}</Badge>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 py-2.5 text-sm">
            <span className="text-text-muted">{t("owner.orgDetail.integration.drive")}</span>
            {overview.googleConnectedAt ? (
              <Badge tone="success" dot>
                {t("owner.orgDetail.integration.connectedAt", {
                  date: formatOwnerDate(overview.googleConnectedAt),
                })}
              </Badge>
            ) : (
              <Badge tone="neutral">{t("owner.orgDetail.integration.notConnected")}</Badge>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-bold text-text-primary">
          {t("owner.orgDetail.activityTitle")}
        </h2>
        {activity.length === 0 ? (
          <EmptyState icon={History} title={t("owner.orgDetail.activityEmpty")} />
        ) : (
          <Card padding="none" className="divide-y divide-border">
            {activity.map((event) => (
              <div key={event.id} className="flex items-start justify-between gap-4 px-5 py-3.5 text-sm">
                <div>
                  <p className="font-medium text-text-primary">{event.description}</p>
                  <p className="mt-0.5 text-xs text-text-muted">{event.eventType}</p>
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
  );
}
