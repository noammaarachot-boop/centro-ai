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
import {
  disableQaModeAction,
  enableQaModeAction,
  disableInitialRequestV2Action,
  enableInitialRequestV2Action,
  disableReminderV2Action,
  enableReminderV2Action,
} from "./[id]/actions";

export const metadata: Metadata = { title: "ארגונים — מסוף בעלים" };

// Phase 2.1 remediation — a human (the platform owner) confirms in Meta
// Business Manager that a specific template is APPROVED on THIS
// organization's own WABA before flipping this; see
// organizations.initialRequestV2Approved/reminderV2Approved's own schema
// doc comment. Same inline toggle-form pattern as qaMode above, reused
// for both templates rather than duplicating the JSX twice.
function TemplateApprovalToggle({
  organizationId,
  label,
  approved,
  enableAction,
  disableAction,
}: {
  organizationId: string;
  label: string;
  approved: boolean;
  enableAction: (formData: FormData) => Promise<void>;
  disableAction: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={approved ? disableAction : enableAction} className="flex items-center gap-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <span className="text-[11px] text-text-muted">{label}:</span>
      <button
        type="submit"
        className={
          approved
            ? "inline-flex items-center rounded-full border border-success/30 bg-success/10 px-2 py-0.5 text-[11px] font-medium text-success transition-colors hover:border-success/50 hover:bg-success/20"
            : "inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:border-brand-purple/40 hover:text-brand-purple"
        }
      >
        {approved ? t("owner.organizations.templateApproval.approved") : t("owner.organizations.templateApproval.markApproved")}
      </button>
    </form>
  );
}

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
                  <div className="flex flex-col items-start gap-1 text-xs text-text-secondary">
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
                    {org.qaModeEnabledAt ? (
                      <form action={disableQaModeAction}>
                        <input type="hidden" name="organizationId" value={org.id} />
                        <button
                          type="submit"
                          className="mt-0.5 inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning transition-colors hover:border-warning/50 hover:bg-warning/20"
                        >
                          {t("owner.organizations.qaMode.badge")}
                        </button>
                      </form>
                    ) : (
                      <form action={enableQaModeAction}>
                        <input type="hidden" name="organizationId" value={org.id} />
                        <button
                          type="submit"
                          className="mt-0.5 inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:border-brand-purple/40 hover:text-brand-purple"
                        >
                          {t("owner.organizations.qaMode.enable")}
                        </button>
                      </form>
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
                  <div className="flex flex-col items-start gap-1.5">
                    <div className="flex gap-1.5">
                      <Badge tone={org.whatsappConnectedAt ? "success" : "neutral"}>WhatsApp</Badge>
                      <Badge tone={org.googleConnectedAt ? "success" : "neutral"}>Drive</Badge>
                    </div>
                    {org.whatsappConnectedAt && (
                      <>
                        <TemplateApprovalToggle
                          organizationId={org.id}
                          label={t("owner.organizations.templateApproval.initialLabel")}
                          approved={org.initialRequestV2Approved}
                          enableAction={enableInitialRequestV2Action}
                          disableAction={disableInitialRequestV2Action}
                        />
                        <TemplateApprovalToggle
                          organizationId={org.id}
                          label={t("owner.organizations.templateApproval.reminderLabel")}
                          approved={org.reminderV2Approved}
                          enableAction={enableReminderV2Action}
                          disableAction={disableReminderV2Action}
                        />
                      </>
                    )}
                    <Link
                      href={`/owner/organizations/${org.id}#whatsapp-manual-connect`}
                      className="mt-0.5 inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-text-muted transition-colors hover:border-brand-purple/40 hover:text-brand-purple"
                    >
                      {t("owner.organizations.whatsapp.manualConnect")}
                    </Link>
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
