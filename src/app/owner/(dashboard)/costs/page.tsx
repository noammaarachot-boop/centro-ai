import type { Metadata } from "next";
import { DollarSign } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import {
  getAiUsageLast30Days,
  getAiUsageToday,
  type AiUsageBreakdownRow,
  type AiUsageReport,
} from "@/lib/data/owner/aiUsage";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = { title: "עלויות AI — מסוף בעלים" };

/**
 * "How much did AI cost me, who spent it, and what caused it."
 *
 * Reads ai_usage_events, which covers EVERY provider call the product makes.
 * It previously read ai_messages, which covered only the assistant — so the
 * twelve classifiers doing the actual product work appeared nowhere, and a
 * quiet page could not be told apart from a page with nothing to show.
 */
function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
}

function BreakdownTable({ title, rows }: { title: string; rows: AiUsageBreakdownRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="mb-6">
      <h3 className="mb-2 text-sm font-semibold text-text-secondary">{title}</h3>
      <Table minWidth={760}>
        <TableHead>
          <TableHeadCell>{t("owner.costs.columns.name")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.calls")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.failed")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.retries")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.inputTokens")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.cachedTokens")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.outputTokens")}</TableHeadCell>
          <TableHeadCell>{t("owner.costs.columns.estimatedCost")}</TableHeadCell>
        </TableHead>
        <tbody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              <TableCell className="font-medium text-text-primary">
                <span dir="auto">{row.label}</span>
              </TableCell>
              <TableCell className="tabular-nums">{row.calls}</TableCell>
              <TableCell className="tabular-nums">
                {row.failedCalls > 0 ? (
                  <span className="font-semibold text-danger">{row.failedCalls}</span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="tabular-nums">{row.retriedCalls > 0 ? row.retriedCalls : "—"}</TableCell>
              <TableCell className="tabular-nums">{row.inputTokens.toLocaleString("en-US")}</TableCell>
              <TableCell className="tabular-nums">
                {row.cachedInputTokens > 0 ? row.cachedInputTokens.toLocaleString("en-US") : "—"}
              </TableCell>
              <TableCell className="tabular-nums">{row.outputTokens.toLocaleString("en-US")}</TableCell>
              <TableCell className="tabular-nums font-semibold text-text-primary">
                {row.estimatedCostUsd === null ? t("owner.costs.costUnavailable") : formatUsd(row.estimatedCostUsd)}
              </TableCell>
            </TableRow>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function UsageSection({ title, report }: { title: string; report: AiUsageReport }) {
  // A non-production row means something other than the deployed product is
  // spending on the same key — surfaced rather than filtered out, because
  // that was an open question this whole area exists to answer.
  const nonProduction = report.byEnvironment.filter((row) => row.key !== "production");

  return (
    <div className="mb-10">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-text-primary">{title}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{t("owner.costs.totalCalls", { count: report.totalCalls })}</Badge>
          <Badge tone="purple">
            {t("owner.costs.totalLabel")}: {formatUsd(report.totalEstimatedCostUsd)}
            {report.hasUnpricedModels ? "+" : ""}
          </Badge>
        </div>
      </div>

      {report.totalCalls === 0 ? (
        <EmptyState
          icon={DollarSign}
          title={t("owner.costs.emptyTitle")}
          description={t("owner.costs.emptyDescription")}
        />
      ) : (
        <>
          <BreakdownTable title={t("owner.costs.byOperation")} rows={report.byOperation} />
          <BreakdownTable title={t("owner.costs.byOrganization")} rows={report.byOrganization} />
          <BreakdownTable title={t("owner.costs.byModel")} rows={report.byModel} />
          <BreakdownTable title={t("owner.costs.byEnvironment")} rows={report.byEnvironment} />

          <div className="space-y-1.5 text-xs text-text-muted">
            {report.hasUnpricedModels && <p>{t("owner.costs.unknownPricingNote")}</p>}
            {report.callsWithoutTokenData > 0 && (
              <p>{t("owner.costs.callsWithoutTokens", { count: report.callsWithoutTokenData })}</p>
            )}
            {report.unattributedCalls > 0 && (
              <p className="font-medium text-warning">
                {t("owner.costs.unattributedCalls", { count: report.unattributedCalls })}
              </p>
            )}
            {nonProduction.length > 0 && (
              <p className="font-medium text-warning">{t("owner.costs.nonProductionWarning")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default async function OwnerCostsPage() {
  await requireOwnerSession();
  const [today, last30Days] = await Promise.all([getAiUsageToday(), getAiUsageLast30Days()]);

  return (
    <div>
      <PageHeader title={t("owner.costs.pageTitle")} description={t("owner.costs.pageDescription")} />
      <Card>
        <UsageSection title={t("owner.costs.sectionToday")} report={today} />
        <UsageSection title={t("owner.costs.section30Days")} report={last30Days} />
      </Card>
    </div>
  );
}
