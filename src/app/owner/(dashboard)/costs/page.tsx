import type { Metadata } from "next";
import { DollarSign } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getOwnerAiCostsToday, getOwnerAiCostsLast30Days, type OwnerAiCostSummary } from "@/lib/data/owner/costs";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = { title: "עלויות AI — מסוף בעלים" };

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
}

function CostSection({ title, summary }: { title: string; summary: OwnerAiCostSummary }) {
  return (
    <div className="mb-8">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-text-primary">{title}</h2>
        <Badge tone="purple">
          {t("owner.costs.totalLabel")}: {formatUsd(summary.totalEstimatedCostUsd)}
          {summary.hasRowsWithUnknownPricing ? "+" : ""}
        </Badge>
      </div>

      {summary.rows.length === 0 ? (
        <EmptyState icon={DollarSign} title={t("owner.costs.emptyTitle")} description={t("owner.costs.emptyDescription")} />
      ) : (
        <Table minWidth={640}>
          <TableHead>
            <TableHeadCell>{t("owner.costs.columns.provider")}</TableHeadCell>
            <TableHeadCell>{t("owner.costs.columns.model")}</TableHeadCell>
            <TableHeadCell>{t("owner.costs.columns.messages")}</TableHeadCell>
            <TableHeadCell>{t("owner.costs.columns.inputTokens")}</TableHeadCell>
            <TableHeadCell>{t("owner.costs.columns.outputTokens")}</TableHeadCell>
            <TableHeadCell>{t("owner.costs.columns.estimatedCost")}</TableHeadCell>
          </TableHead>
          <tbody>
            {summary.rows.map((row) => (
              <TableRow key={`${row.provider}-${row.modelId}`}>
                <TableCell className="font-medium text-text-primary">{row.provider}</TableCell>
                <TableCell className="text-end">
                  <span dir="ltr">{row.modelId}</span>
                </TableCell>
                <TableCell className="tabular-nums">{row.messageCount}</TableCell>
                <TableCell className="tabular-nums">{row.inputTokens.toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">{row.outputTokens.toLocaleString("en-US")}</TableCell>
                <TableCell className="tabular-nums">
                  {row.estimatedCostUsd === null ? (
                    <Badge tone="neutral">{t("owner.costs.costUnavailable")}</Badge>
                  ) : (
                    formatUsd(row.estimatedCostUsd)
                  )}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}

      {(summary.hasRowsWithUnknownPricing || summary.messagesWithoutUsageData > 0) && (
        <div className="mt-2 space-y-1 text-xs text-text-muted">
          {summary.hasRowsWithUnknownPricing && <p>{t("owner.costs.unknownPricingNote")}</p>}
          {summary.messagesWithoutUsageData > 0 && (
            <p>{t("owner.costs.messagesWithoutUsage", { count: summary.messagesWithoutUsageData })}</p>
          )}
        </div>
      )}
    </div>
  );
}

export default async function OwnerCostsPage() {
  await requireOwnerSession();

  const [today, last30Days] = await Promise.all([getOwnerAiCostsToday(), getOwnerAiCostsLast30Days()]);

  return (
    <div>
      <PageHeader title={t("owner.costs.pageTitle")} description={t("owner.costs.pageDescription")} />
      <Card padding="lg">
        <CostSection title={t("owner.costs.sectionToday")} summary={today} />
        <CostSection title={t("owner.costs.section30Days")} summary={last30Days} />
      </Card>
    </div>
  );
}
