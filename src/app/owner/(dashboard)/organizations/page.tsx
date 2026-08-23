import type { Metadata } from "next";
import Link from "next/link";
import { Building2, ChevronLeft, Mail, Phone, Search } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { listOrganizations } from "@/lib/data/owner/organizations";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { Badge } from "@/components/app/Badge";
import { EmptyState } from "@/components/app/EmptyState";
import { ConnectionStatusRow } from "@/components/owner/ConnectionStatusRow";
import { formatOwnerDate } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";

export const metadata: Metadata = { title: "ארגונים — מסוף בעלים" };

// Organization rows replace the previous 6-column table. The table packed
// up to four separate controls into a single "חיבורים" cell (two badges
// plus two template-approval toggles) alongside an ambiguous
// "הגדר WhatsApp" link that read as neither status nor action.
//
// Now each row states the connection situation in words, and the template
// approval toggles moved to the organization's own page, next to the
// templates they describe.
//
// "סוג תהליך" (workflowType) is deliberately no longer rendered. The
// column, its type and every consumer are untouched — this is a display
// decision only, reversible by re-adding the markup.
export default async function OwnerOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireOwnerSession();
  const { q } = await searchParams;
  const query = q?.trim() ?? "";
  const organizations = await listOrganizations(query);

  return (
    <div>
      <PageHeader
        title={t("owner.organizations.pageTitle")}
        description={
          query
            ? t("owner.organizations.searchResultsFor", { query })
            : t("owner.organizations.pageDescription")
        }
      />

      {/* In-page search, pre-filled with the active query — the header
          search box cannot show what is currently filtering the list. */}
      <form action="/owner/organizations" method="GET" className="mb-5">
        <div className="relative">
          <Search
            className="pointer-events-none absolute inset-y-0 start-3.5 my-auto h-4 w-4 text-text-muted"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="חיפוש לפי שם ארגון, אימייל או טלפון…"
            aria-label="חיפוש ארגונים"
            className="w-full rounded-full border border-border bg-surface py-2.5 ps-10 pe-4 text-sm text-text-primary outline-none transition-colors focus:border-brand-purple"
          />
        </div>
      </form>

      {organizations.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={query ? "לא נמצאו ארגונים תואמים" : t("owner.organizations.emptyTitle")}
          description={
            query
              ? "נסו מונח חיפוש אחר, או נקו את החיפוש כדי לראות את כל הארגונים."
              : t("owner.organizations.emptyDescription")
          }
        />
      ) : (
        <div className="space-y-3">
          {organizations.map((org) => (
            <Card key={org.id} padding="none" interactive>
              <Link
                href={`/owner/organizations/${org.id}`}
                className="flex items-start justify-between gap-4 px-5 py-4"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-bold text-text-primary">
                      {org.name?.trim() || t("owner.organizations.unnamed")}
                    </span>
                    {org.suspendedAt && <Badge tone="danger">{t("owner.organizations.suspended")}</Badge>}
                    {org.qaModeEnabledAt && (
                      <Badge tone="warning">{t("owner.organizations.qaMode.badge")}</Badge>
                    )}
                    {!org.onboardingCompletedAt && (
                      <Badge tone="warning">{t("owner.organizations.onboarding.incomplete")}</Badge>
                    )}
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-secondary">
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
                    <span className="text-text-muted">{formatOwnerDate(org.createdAt)}</span>
                  </div>

                  {/* Two plain sentences instead of a pile of coloured chips. */}
                  <div className="mt-2.5 flex flex-col gap-1 sm:flex-row sm:flex-wrap sm:gap-x-5">
                    <ConnectionStatusRow service="WhatsApp" health={org.whatsappHealth} compact />
                    <ConnectionStatusRow service="Google Drive" health={org.driveHealth} compact />
                  </div>
                </div>

                <ChevronLeft className="mt-1 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
