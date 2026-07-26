import type { Metadata } from "next";
import Link from "next/link";
import { Building2, Mail, Phone } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { listOrganizations } from "@/lib/data/owner/organizations";
import { PageHeader } from "@/components/app/PageHeader";
import { Table, TableHead, TableHeadCell, TableRow, TableCell } from "@/components/app/Table";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { formatOwnerDate } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = { title: "ארגונים — מסוף בעלים" };

export default async function OwnerOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireOwnerSession();
  const { q } = await searchParams;
  const organizations = await listOrganizations(q);

  return (
    <div>
      <PageHeader
        title={t("owner.organizations.pageTitle")}
        description={
          q?.trim()
            ? t("owner.organizations.searchResultsFor", { query: q.trim() })
            : t("owner.organizations.pageDescription")
        }
      />

      {organizations.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t("owner.organizations.emptyTitle")}
          description={t("owner.organizations.emptyDescription")}
        />
      ) : (
        <Table minWidth={720}>
          <TableHead>
            <TableHeadCell>{t("owner.organizations.columns.name")}</TableHeadCell>
            <TableHeadCell>{t("owner.organizations.columns.contact")}</TableHeadCell>
            <TableHeadCell>{t("owner.organizations.columns.workflowType")}</TableHeadCell>
            <TableHeadCell>{t("owner.organizations.columns.onboarding")}</TableHeadCell>
            <TableHeadCell>{t("owner.organizations.columns.integrations")}</TableHeadCell>
            <TableHeadCell>{t("owner.organizations.columns.createdAt")}</TableHeadCell>
          </TableHead>
          <tbody>
            {organizations.map((org) => (
              <TableRow key={org.id}>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/owner/organizations/${org.id}`}
                      className="font-semibold text-text-primary transition-colors hover:text-brand-purple"
                    >
                      {org.name?.trim() || t("owner.organizations.unnamed")}
                    </Link>
                    {org.suspendedAt && (
                      <Badge tone="danger">{t("owner.organizations.suspended")}</Badge>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1 text-xs text-text-secondary">
                    {org.userEmail && (
                      <span className="flex items-center gap-1.5">
                        <Mail className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {org.userEmail}
                      </span>
                    )}
                    {org.userPhone && (
                      <span className="flex items-center gap-1.5" dir="ltr">
                        <Phone className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {org.userPhone}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge tone="neutral">
                    {org.workflowType === "one_time"
                      ? t("owner.organizations.workflowType.oneTime")
                      : t("owner.organizations.workflowType.recurring")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Badge tone={org.onboardingCompletedAt ? "success" : "warning"} dot>
                    {org.onboardingCompletedAt
                      ? t("owner.organizations.onboarding.complete")
                      : t("owner.organizations.onboarding.incomplete")}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1.5">
                    <Badge tone={org.whatsappConnectedAt ? "success" : "neutral"}>WhatsApp</Badge>
                    <Badge tone={org.googleConnectedAt ? "success" : "neutral"}>Drive</Badge>
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap text-text-muted">
                  {formatOwnerDate(org.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
