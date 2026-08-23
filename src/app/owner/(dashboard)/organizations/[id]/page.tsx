import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ShieldAlert, ShieldCheck, Users, ClipboardList, ListChecks, History } from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { getOrganizationOverview } from "@/lib/data/owner/organizations";
import { listAuditLog } from "@/lib/data/auditLog";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { KpiCard } from "@/components/app/KpiCard";
import { Badge } from "@/components/app/Badge";
import { Button } from "@/components/app/Button";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EmptyState } from "@/components/app/EmptyState";
import { TextField } from "@/components/app/FormField";
import { formatOwnerDate, formatOwnerDateTime } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";
import {
  manuallyConnectWhatsAppAction,
  reactivateOrganizationAction,
  suspendOrganizationAction,
} from "./actions";
import {
  refreshWhatsAppTemplateStatusesAction,
  submitWhatsAppTemplateAction,
} from "./templateActions";
import { listOwnerTemplates } from "@/lib/data/owner/templates";

export const metadata: Metadata = { title: "פרטי ארגון — מסוף בעלים" };

// Meta's own review vocabulary. Anything Meta adds later falls through to
// the raw status string with a neutral tone, rather than being hidden.
const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  LOCAL_DRAFT: "טרם הוגשה",
  PENDING: "ממתינה לאישור",
  APPROVED: "אושרה",
  REJECTED: "נדחתה",
  PAUSED: "מושהית",
  DISABLED: "מושבתת",
  IN_APPEAL: "בערעור",
  PENDING_DELETION: "ממתינה למחיקה",
};

const TEMPLATE_STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  LOCAL_DRAFT: "neutral",
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  PAUSED: "warning",
  DISABLED: "danger",
  IN_APPEAL: "warning",
  PENDING_DELETION: "warning",
};

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
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    whatsappConnected?: string;
    whatsappError?: string;
    templateError?: string;
    templateSubmitted?: string;
    templateRefreshed?: string;
  }>;
}) {
  await requireOwnerSession();
  const { id } = await params;
  const { whatsappConnected, whatsappError, templateError, templateSubmitted, templateRefreshed } =
    await searchParams;

  const overview = await getOrganizationOverview(id);
  if (!overview) notFound();

  const activity = await listAuditLog(id, {}, 50);
  const templates = await listOwnerTemplates(id);

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
          <>
            <Badge tone={overview.onboardingCompletedAt ? "success" : "warning"} dot>
              {overview.onboardingCompletedAt
                ? t("owner.organizations.onboarding.complete")
                : t("owner.organizations.onboarding.incomplete")}
            </Badge>
            {overview.suspendedAt ? (
              <form action={reactivateOrganizationAction}>
                <input type="hidden" name="organizationId" value={overview.id} />
                <Button type="submit" variant="secondary" size="sm">
                  <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                  {t("owner.orgDetail.reactivateTrigger")}
                </Button>
              </form>
            ) : (
              <ConfirmDialog
                trigger={
                  <span className="flex items-center gap-1.5">
                    <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                    {t("owner.orgDetail.suspendTrigger")}
                  </span>
                }
                triggerClassName="inline-flex items-center gap-1.5 rounded-full border border-danger/25 bg-danger/5 px-3.5 py-2 text-xs font-semibold text-danger transition-colors hover:border-danger/50 hover:bg-danger/10"
                title={t("owner.orgDetail.suspendTitle")}
                description={t("owner.orgDetail.suspendDescription")}
                confirmLabel={t("owner.orgDetail.suspendConfirm")}
                formAction={suspendOrganizationAction}
                hiddenFields={{ organizationId: overview.id }}
              />
            )}
          </>
        }
      />

      {overview.suspendedAt && (
        <div className="mb-6 rounded-2xl border border-danger/25 bg-danger/5 px-4 py-3 text-sm font-medium text-danger">
          {t("owner.orgDetail.suspendedBanner", { date: formatOwnerDate(overview.suspendedAt) })}
        </div>
      )}

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
          <div className="border-b border-border py-2.5 text-sm">
            <div className="flex items-center justify-between gap-4">
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
            {overview.whatsappConnectedAt && (
              <p className="mt-1.5 text-xs text-text-muted">
                {overview.whatsappManuallyConnected ? "חיבור ידני" : "Embedded Signup"}
                {overview.whatsappDisplayPhoneNumber && ` · ${overview.whatsappDisplayPhoneNumber}`}
                {overview.whatsappVerifiedName && ` · ${overview.whatsappVerifiedName}`}
              </p>
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

      {/* Manual per-organization WhatsApp connection — owner-only. An
          office that set up its own WhatsApp Cloud API access outside
          Embedded Signup and gave Centro's owner its own Access Token,
          WABA ID, and Phone Number ID. "בדוק וחבר" verifies the token
          against Meta itself before ever saving anything (see
          manuallyConnectWhatsAppAction) — a failed attempt never touches
          this organization's existing WhatsApp connection, if any. */}
      <Card id="whatsapp-manual-connect" className="mt-6 scroll-mt-6">
        <h2 className="mb-1.5 text-sm font-bold text-text-primary">חיבור WhatsApp ידני</h2>
        <p className="mb-4 text-xs text-text-secondary">
          לחיבור עצמאי, ללא Embedded Signup — הזינו את הפרטים שהתקבלו מ-Meta עבור ה-WhatsApp Business
          Account של המשרד. הבדיקה מתבצעת מול Meta לפני השמירה; הטוקן נשמר מוצפן ולא יוצג שוב.
        </p>

        {whatsappConnected && (
          <p
            role="status"
            className="mb-4 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm font-medium text-success"
          >
            החיבור בוצע בהצלחה.
          </p>
        )}
        {whatsappError && (
          <p
            role="alert"
            className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
          >
            {decodeURIComponent(whatsappError)}
          </p>
        )}
        {/* Per-number webhook override (Meta "Webhook overrides"). Always
            shown once a pair exists — Centro's own dynamic route honours it
            whether or not Meta accepted the automatic registration, so
            showing it is exactly what lets the owner register it by hand
            when the automatic attempt didn't go through. The status line is
            the honest part: it says whether Meta is actually routing here
            yet, rather than the presence of the box implying it. */}
        {overview.whatsappWebhookUrl && overview.whatsappWebhookVerifyToken && (
          <div
            className={`mb-4 rounded-xl border px-4 py-3 ${
              overview.whatsappWebhookOverrideActive
                ? "border-success/30 bg-success/5"
                : "border-warning/30 bg-warning/5"
            }`}
          >
            <p
              className={`mb-2 text-sm font-semibold ${
                overview.whatsappWebhookOverrideActive ? "text-success" : "text-warning"
              }`}
            >
              {overview.whatsappWebhookOverrideActive
                ? "כתובת Webhook ייעודית למספר הזה — רשומה ופעילה ב-Meta"
                : "כתובת Webhook ייעודית למספר הזה — טרם נרשמה ב-Meta"}
            </p>
            <p className="mb-3 text-xs text-text-secondary">
              {overview.whatsappWebhookOverrideActive
                ? "הודעות נכנסות של המשרד הזה מגיעות לכתובת הזו במקום לכתובת המשותפת. אין צורך לעשות דבר — הפרטים מוצגים לאימות ולמעקב."
                : "הכתובת והאסימון נוצרו ומוכנים לשימוש, אך Meta עדיין לא הופנתה אליהם — ההודעות ממשיכות להגיע כרגיל דרך הכתובת המשותפת, והחיבור עובד במלואו. אפשר לרשום אותם ידנית ב-Meta (WhatsApp → Configuration של המספר), או ללחוץ “בדוק וחבר” שוב כדי שננסה אוטומטית."}
            </p>
            <dl className="space-y-2 text-xs">
              <div>
                <dt className="mb-0.5 font-medium text-text-muted">Callback URL</dt>
                <dd
                  dir="ltr"
                  className="overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 font-mono text-text-primary"
                >
                  {overview.whatsappWebhookUrl}
                </dd>
              </div>
              <div>
                <dt className="mb-0.5 font-medium text-text-muted">Verify Token</dt>
                <dd
                  dir="ltr"
                  className="overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 font-mono text-text-primary"
                >
                  {overview.whatsappWebhookVerifyToken}
                </dd>
              </div>
            </dl>
          </div>
        )}

        <form action={manuallyConnectWhatsAppAction} className="space-y-4">
          <input type="hidden" name="organizationId" value={overview.id} />
          <TextField
            id="wabaId"
            name="wabaId"
            label="WABA ID"
            required
            dir="ltr"
            defaultValue={overview.whatsappBusinessAccountId ?? ""}
            placeholder="1234567890123456"
          />
          <TextField
            id="phoneNumberId"
            name="phoneNumberId"
            label="Phone Number ID"
            required
            dir="ltr"
            defaultValue={overview.whatsappPhoneNumberId ?? ""}
            placeholder="1234567890123456"
          />
          <TextField
            id="accessToken"
            name="accessToken"
            label="Access Token"
            type="password"
            required
            dir="ltr"
            placeholder="EAAG..."
          />
          <Button type="submit" variant="primary" size="sm">
            בדוק וחבר
          </Button>
        </form>
      </Card>

      {/* Owner-managed WhatsApp templates, submitted to THIS organization's
          own WABA with its own token (see templateActions.ts). Offered only
          for a manually-connected organization, since an Embedded Signup
          one has no per-org token to submit with — its templates keep being
          provisioned the existing way, untouched. */}
      {overview.whatsappManuallyConnected && (
        <Card id="whatsapp-templates" className="mt-6 scroll-mt-6">
          <div className="mb-1.5 flex items-center justify-between gap-4">
            <h2 className="text-sm font-bold text-text-primary">תבניות WhatsApp</h2>
            <form action={refreshWhatsAppTemplateStatusesAction}>
              <input type="hidden" name="organizationId" value={overview.id} />
              <Button type="submit" variant="secondary" size="sm">
                רענן סטטוס מול Meta
              </Button>
            </form>
          </div>
          <p className="mb-4 text-xs text-text-secondary">
            תבניות שמוגשות לאישור Meta עבור ה-WhatsApp Business Account של המשרד הזה בלבד. המשתנה{" "}
            <span dir="ltr" className="font-mono">
              {"{{1}}"}
            </span>{" "}
            מייצג תמיד את רשימת המסמכים הדינמית — לא שם לקוח.
          </p>

          {templateError && (
            <p
              role="alert"
              className="mb-4 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
            >
              {decodeURIComponent(templateError)}
            </p>
          )}
          {templateSubmitted && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm font-medium text-success"
            >
              התבנית „{decodeURIComponent(templateSubmitted)}” הוגשה לאישור Meta.
            </p>
          )}
          {templateRefreshed && (
            <p
              role="status"
              className="mb-4 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm font-medium text-text-secondary"
            >
              {templateRefreshed === "0"
                ? "לא נמצאו תבניות מנוהלות על ה-WABA הזה עדיין."
                : `סטטוס עודכן מול Meta עבור ${decodeURIComponent(templateRefreshed)} תבניות.`}
            </p>
          )}

          <div className="space-y-4">
            {templates.map((template) => (
              <div key={template.name} className="rounded-xl border border-border p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-text-primary">{template.label}</h3>
                    <Badge tone={TEMPLATE_STATUS_TONE[template.status] ?? "neutral"} dot>
                      {TEMPLATE_STATUS_LABEL[template.status] ?? template.status}
                    </Badge>
                  </div>
                  <span dir="ltr" className="font-mono text-[11px] text-text-muted">
                    {template.name} · {template.language} · {template.category}
                  </span>
                </div>

                {/* Preview — the exact body Meta reviews, with {{1}} shown
                    filled in by the example so the owner sees the real
                    message rather than a placeholder. */}
                <div className="mb-3 whitespace-pre-wrap rounded-lg border border-border bg-surface-muted/60 px-3 py-2 text-xs text-text-primary">
                  {template.bodyText.replace("{{1}}", template.exampleValue)}
                </div>

                {template.status === "REJECTED" && template.rejectedReasonText && (
                  <p className="mb-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                    <span className="font-semibold">נדחתה על ידי Meta</span>
                    {template.rejectedReason ? ` (${template.rejectedReason})` : ""}:{" "}
                    {template.rejectedReasonText}
                  </p>
                )}

                <form action={submitWhatsAppTemplateAction} className="space-y-3">
                  <input type="hidden" name="organizationId" value={overview.id} />
                  <input type="hidden" name="templateName" value={template.name} />
                  <TextField
                    id={`example-${template.name}`}
                    name="exampleValue"
                    label="ערך לדוגמה עבור {{1}} (נשלח ל-Meta)"
                    required
                    defaultValue={template.exampleValue}
                    placeholder="תעודת זהות, 3 תלושי שכר ואישור ניהול חשבון"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button type="submit" variant="primary" size="sm">
                      {template.metaTemplateId ? "הגש מחדש לאישור Meta" : "שלח לאישור Meta"}
                    </Button>
                    {template.lastSyncedAt && (
                      <span className="text-[11px] text-text-muted">
                        סונכרן לאחרונה: {formatOwnerDateTime(template.lastSyncedAt)}
                      </span>
                    )}
                  </div>
                </form>
              </div>
            ))}
          </div>
        </Card>
      )}

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
