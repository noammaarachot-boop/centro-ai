import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  CheckCircle2,
  ClipboardList,
  ListChecks,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import {
  getOrganizationOverview,
  getOrganizationWhatsAppToken,
} from "@/lib/data/owner/organizations";
import { listAuditLog } from "@/lib/data/auditLog";
import { listOwnerTemplates } from "@/lib/data/owner/templates";
import { PageHeader } from "@/components/app/PageHeader";
import { KpiCard } from "@/components/app/KpiCard";
import { Badge } from "@/components/app/Badge";
import { Button } from "@/components/app/Button";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { TextField } from "@/components/app/FormField";
import { CollapsibleSection } from "@/components/owner/CollapsibleSection";
import { ConnectionStatusRow } from "@/components/owner/ConnectionStatusRow";
import { AsyncActionButton } from "@/components/owner/AsyncActionButton";
import { SecretValue } from "@/components/owner/SecretValue";
import { ActivityFeed } from "@/components/owner/ActivityFeed";
import { formatOwnerDate, formatOwnerDateTime } from "@/lib/owner/formatDate";
import { t } from "@/lib/owner/i18n/t";
import {
  disableInitialRequestV2Action,
  enableInitialRequestV2Action,
  disableReminderV2Action,
  enableReminderV2Action,
  manuallyConnectWhatsAppAction,
  reactivateOrganizationAction,
  suspendOrganizationAction,
} from "./actions";
import { checkDriveConnectionAction, checkWhatsAppConnectionAction } from "./connectionActions";
import {
  editWhatsAppTemplateAction,
  refreshWhatsAppTemplateStatusesAction,
  submitWhatsAppTemplateAction,
} from "./templateActions";

export const metadata: Metadata = { title: "פרטי ארגון — מסוף בעלים" };

// Meta's own review vocabulary. An unrecognized value falls through to the
// raw status rather than being hidden.
const TEMPLATE_STATUS_LABEL: Record<string, string> = {
  LOCAL_DRAFT: "טרם הוגשה",
  PENDING: "ממתינה לאישור",
  APPROVED: "מאושרת",
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
    <div className="flex items-start justify-between gap-4 border-b border-border py-2.5 text-sm last:border-b-0">
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 text-end font-medium text-text-primary">{value}</span>
    </div>
  );
}

function TechnicalValue({ value }: { value: string | null }) {
  if (!value) return <span className="text-text-muted">—</span>;
  return (
    <code dir="ltr" className="font-mono text-xs text-text-primary">
      {value}
    </code>
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
    templateEdited?: string;
    templateRefreshed?: string;
  }>;
}) {
  await requireOwnerSession();
  const { id } = await params;
  const {
    whatsappConnected,
    whatsappError,
    templateError,
    templateSubmitted,
    templateEdited,
    templateRefreshed,
  } = await searchParams;

  const overview = await getOrganizationOverview(id);
  if (!overview) notFound();

  const [activity, templates, whatsappToken] = await Promise.all([
    listAuditLog(id, {}, 50),
    listOwnerTemplates(id),
    getOrganizationWhatsAppToken(id),
  ]);

  const bothConnected =
    overview.whatsappHealth.state === "connected" && overview.driveHealth.state === "connected";
  const anyNeedsAttention =
    overview.whatsappHealth.state === "needs_attention" ||
    overview.driveHealth.state === "needs_attention";

  const approvedTemplates = templates.filter((template) => template.status === "APPROVED").length;

  // The last explicit check's outcome, rendered next to its button so the
  // ✓/✕ survives the redirect that follows the action.
  const whatsappCheckOutcome =
    overview.whatsappHealthCheckedAt === null
      ? null
      : {
          ok: overview.whatsappHealthOk === true,
          message:
            overview.whatsappHealthOk === true
              ? "החיבור תקין"
              : (overview.whatsappHealthReason ?? "החיבור נכשל"),
        };
  const driveCheckOutcome =
    overview.googleHealthCheckedAt === null
      ? null
      : {
          ok: overview.googleHealthOk === true,
          message:
            overview.googleHealthOk === true
              ? "החיבור תקין"
              : (overview.googleHealthReason ?? "החיבור נכשל"),
        };

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

      {/* ===== Overall status ===== */}
      <div
        className={`mb-5 rounded-2xl border px-5 py-4 ${
          anyNeedsAttention
            ? "border-danger/30 bg-danger/5"
            : bothConnected
              ? "border-success/30 bg-success/5"
              : "border-border bg-surface-muted/40"
        }`}
      >
        {bothConnected ? (
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-success" aria-hidden="true" />
            <div>
              <p className="text-sm font-bold text-success">החיבורים תקינים</p>
              <p className="mt-0.5 text-xs text-text-secondary">
                WhatsApp
                {overview.whatsappDisplayPhoneNumber ? ` · ${overview.whatsappDisplayPhoneNumber}` : ""}
                {" | "}
                Google Drive
                {overview.googleDriveFolderName ? ` · ${overview.googleDriveFolderName}` : ""}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            <ConnectionStatusRow
              service="WhatsApp"
              health={overview.whatsappHealth}
              detail={overview.whatsappDisplayPhoneNumber}
            />
            <ConnectionStatusRow
              service="Google Drive"
              health={overview.driveHealth}
              detail={overview.googleDriveFolderName}
            />
          </div>
        )}
      </div>

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

      <div className="mt-5 space-y-3">
        {/* ===== א. חיבורים ===== */}
        <div id="connections" className="scroll-mt-6">
          <CollapsibleSection
            title="חיבורים"
            subtitle="בדיקה חיה מול Meta ו-Google"
            defaultOpen={anyNeedsAttention}
            badge={
              bothConnected ? (
                <Badge tone="success" dot>
                  תקין
                </Badge>
              ) : anyNeedsAttention ? (
                <Badge tone="danger" dot>
                  דורש טיפול
                </Badge>
              ) : undefined
            }
          >
            <div className="space-y-5">
              <div>
                <ConnectionStatusRow
                  service="WhatsApp"
                  health={overview.whatsappHealth}
                  detail={overview.whatsappDisplayPhoneNumber}
                />
                <form action={checkWhatsAppConnectionAction} className="mt-2.5">
                  <input type="hidden" name="organizationId" value={overview.id} />
                  <AsyncActionButton
                    idleLabel="בדוק חיבור"
                    pendingLabel="בודק מול Meta…"
                    variant="secondary"
                    outcome={whatsappCheckOutcome}
                    icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                  />
                </form>
                {overview.whatsappHealthCheckedAt && (
                  <p className="mt-1.5 text-[11px] text-text-muted">
                    נבדק לאחרונה: {formatOwnerDateTime(overview.whatsappHealthCheckedAt)}
                  </p>
                )}
              </div>

              <div className="border-t border-border pt-5">
                <ConnectionStatusRow
                  service="Google Drive"
                  health={overview.driveHealth}
                  detail={overview.googleDriveFolderName}
                />
                <form action={checkDriveConnectionAction} className="mt-2.5">
                  <input type="hidden" name="organizationId" value={overview.id} />
                  <AsyncActionButton
                    idleLabel="בדוק חיבור"
                    pendingLabel="בודק מול Google…"
                    variant="secondary"
                    outcome={driveCheckOutcome}
                    icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                  />
                </form>
                {overview.googleHealthCheckedAt && (
                  <p className="mt-1.5 text-[11px] text-text-muted">
                    נבדק לאחרונה: {formatOwnerDateTime(overview.googleHealthCheckedAt)}
                  </p>
                )}
              </div>
            </div>
          </CollapsibleSection>
        </div>

        {/* ===== ב. תבניות WhatsApp ===== */}
        {overview.whatsappManuallyConnected && (
          <div id="whatsapp-templates" className="scroll-mt-6">
            <CollapsibleSection
              title="תבניות WhatsApp"
              subtitle="מוגשות ל-Meta עבור ה-WABA של המשרד הזה"
              defaultOpen={templates.some((template) => template.status === "REJECTED")}
              badge={
                <Badge tone={approvedTemplates === templates.length ? "success" : "neutral"}>
                  {approvedTemplates}/{templates.length} מאושרות
                </Badge>
              }
            >
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
              {templateEdited && (
                <p
                  role="status"
                  className="mb-4 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm font-medium text-success"
                >
                  התבנית „{decodeURIComponent(templateEdited)}” עודכנה ונשלחה לבדיקה מחודשת ב-Meta.
                </p>
              )}
              {templateRefreshed && (
                <p
                  role="status"
                  className="mb-4 rounded-xl border border-border bg-surface-muted px-4 py-3 text-sm text-text-secondary"
                >
                  {templateRefreshed === "0"
                    ? "לא נמצאו תבניות מנוהלות על ה-WABA הזה עדיין."
                    : `סטטוס עודכן מול Meta עבור ${decodeURIComponent(templateRefreshed)} תבניות.`}
                </p>
              )}

              <form action={refreshWhatsAppTemplateStatusesAction} className="mb-4">
                <input type="hidden" name="organizationId" value={overview.id} />
                <AsyncActionButton
                  idleLabel="רענן סטטוס מול Meta"
                  pendingLabel="מסנכרן…"
                  variant="secondary"
                  icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
                />
              </form>

              <div className="space-y-3">
                {templates.map((template) => (
                  <div key={template.name} className="rounded-xl border border-border p-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text-primary">{template.label}</h3>
                        <p className="mt-0.5 text-xs text-text-muted">{template.purpose}</p>
                      </div>
                      <Badge tone={TEMPLATE_STATUS_TONE[template.status] ?? "neutral"} dot>
                        {TEMPLATE_STATUS_LABEL[template.status] ?? template.status}
                      </Badge>
                    </div>

                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-muted">
                      <span>קטגוריה: {template.category}</span>
                      <span>שפה: {template.language}</span>
                      {template.lastSyncedAt && (
                        <span>עודכן: {formatOwnerDateTime(template.lastSyncedAt)}</span>
                      )}
                    </div>

                    {template.status === "REJECTED" && template.rejectedReasonText && (
                      <p className="mt-2.5 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
                        <span className="font-semibold">Meta דחתה</span>
                        {template.rejectedReason ? ` (${template.rejectedReason})` : ""}:{" "}
                        {template.rejectedReasonText}
                      </p>
                    )}

                    {/* Full preview is one click away rather than always open. */}
                    <details className="mt-2.5">
                      <summary className="cursor-pointer list-none text-xs font-medium text-brand-purple">
                        תצוגה מקדימה
                      </summary>
                      <div className="mt-2 whitespace-pre-wrap rounded-lg border border-border bg-surface-muted/60 px-3 py-2.5 text-xs text-text-primary">
                        {template.bodyText.replace("{{1}}", template.exampleValue)}
                      </div>
                      <p className="mt-1.5 text-[11px] text-text-muted">
                        שם התבנית ב-Meta:{" "}
                        <code dir="ltr" className="font-mono">
                          {template.name}
                        </code>
                        {" · "}שם ושפה אינם ניתנים לשינוי
                      </p>
                    </details>

                    {/* Submit (first time / after rejection) or edit. */}
                    <form
                      action={
                        template.metaTemplateId && template.canEdit
                          ? editWhatsAppTemplateAction
                          : submitWhatsAppTemplateAction
                      }
                      className="mt-3 space-y-2.5 border-t border-border pt-3"
                    >
                      <input type="hidden" name="organizationId" value={overview.id} />
                      <input type="hidden" name="templateName" value={template.name} />
                      <TextField
                        id={`example-${template.name}`}
                        name="exampleValue"
                        label="ערך לדוגמה עבור {{1}} — רשימת המסמכים"
                        required
                        defaultValue={template.exampleValue}
                        placeholder="תעודת זהות, 3 תלושי שכר ואישור ניהול חשבון"
                      />
                      {template.metaTemplateId && !template.canEdit ? (
                        <p className="text-xs text-text-muted">{template.editBlockedReason}</p>
                      ) : (
                        <AsyncActionButton
                          idleLabel={
                            template.metaTemplateId ? "שמור ושלח לאישור Meta" : "שלח לאישור Meta"
                          }
                          pendingLabel="שולח ל-Meta…"
                        />
                      )}
                    </form>
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </div>
        )}

        {/* ===== ג. פעילות אחרונה ===== */}
        <CollapsibleSection
          title={t("owner.orgDetail.activityTitle")}
          subtitle={activity.length === 0 ? "אין פעילות" : `${activity.length} אירועים אחרונים`}
        >
          <ActivityFeed
            events={activity.map((event) => ({
              id: event.id,
              occurredAt: event.occurredAt,
              eventType: event.eventType,
              description: event.description,
              source: "organization" as const,
              organizationName: null,
            }))}
            showOrganization={false}
            emptyTitle={t("owner.orgDetail.activityEmpty")}
          />
        </CollapsibleSection>

        {/* ===== ד. פרטים מתקדמים ===== */}
        <CollapsibleSection title="פרטים מתקדמים" subtitle="מזהים טכניים, Webhook וחיבור ידני">
          <div className="space-y-6">
            <div>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-text-muted">
                פרטי הארגון
              </h3>
              <InfoRow
                label={t("owner.orgDetail.field.phone")}
                value={overview.userPhone ?? t("owner.orgDetail.field.notProvided")}
              />
              <InfoRow
                label={t("owner.orgDetail.field.fullName")}
                value={overview.userFullName ?? t("owner.orgDetail.field.notProvided")}
              />
              <InfoRow
                label={t("owner.orgDetail.field.createdAt")}
                value={formatOwnerDate(overview.createdAt)}
              />
              <InfoRow
                label={t("owner.orgDetail.field.businessCategory")}
                value={overview.businessCategoryCustomLabel ?? overview.businessCategory}
              />
            </div>

            <div>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-text-muted">
                מזהי WhatsApp
              </h3>
              <InfoRow
                label="סוג החיבור"
                value={overview.whatsappManuallyConnected ? "חיבור ידני" : "Embedded Signup"}
              />
              <InfoRow label="WABA ID" value={<TechnicalValue value={overview.whatsappBusinessAccountId} />} />
              <InfoRow
                label="Phone Number ID"
                value={<TechnicalValue value={overview.whatsappPhoneNumberId} />}
              />
              <InfoRow label="שם מאומת" value={overview.whatsappVerifiedName ?? "—"} />
              {whatsappToken && (
                <div className="border-b border-border py-2.5 last:border-b-0">
                  <p className="mb-1.5 text-sm text-text-muted">Access Token</p>
                  {/* Masked on every load; revealing is explicit and never persisted. */}
                  <SecretValue value={whatsappToken} label="Access Token" />
                </div>
              )}
            </div>

            {overview.whatsappWebhookUrl && overview.whatsappWebhookVerifyToken && (
              <div>
                <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-text-muted">
                  Webhook ייעודי למספר
                </h3>
                <p className="mb-2 text-xs text-text-secondary">
                  {overview.whatsappWebhookOverrideActive
                    ? "רשום ופעיל ב-Meta — הודעות נכנסות של המשרד מגיעות לכתובת הזו."
                    : "נוצר ומוכן, אך Meta עדיין לא הופנתה אליו — ההודעות מגיעות דרך הכתובת המשותפת."}
                </p>
                <div className="space-y-2">
                  <div>
                    <p className="mb-1 text-xs text-text-muted">Callback URL</p>
                    <code
                      dir="ltr"
                      className="block overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-text-primary"
                    >
                      {overview.whatsappWebhookUrl}
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-text-muted">Verify Token</p>
                    <SecretValue value={overview.whatsappWebhookVerifyToken} label="Verify Token" />
                  </div>
                </div>
              </div>
            )}

            {/* Template approval flags — moved here from the organizations
                table, where they were four controls crammed into one cell.
                The actions and the columns behind them are unchanged. */}
            {overview.whatsappConnectedAt && (
              <div>
                <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-text-muted">
                  אישור תבניות ישנות (v2)
                </h3>
                <p className="mb-2 text-xs text-text-secondary">
                  סימון ידני שמאשר שהתבנית אושרה ב-Meta עבור ה-WABA הזה. משפיע על מסלול השליחה הקיים.
                </p>
                <div className="flex flex-wrap gap-2">
                  <form
                    action={
                      overview.initialRequestV2Approved
                        ? disableInitialRequestV2Action
                        : enableInitialRequestV2Action
                    }
                  >
                    <input type="hidden" name="organizationId" value={overview.id} />
                    <Button type="submit" variant="secondary" size="sm">
                      {t("owner.organizations.templateApproval.initialLabel")}:{" "}
                      {overview.initialRequestV2Approved
                        ? t("owner.organizations.templateApproval.approved")
                        : t("owner.organizations.templateApproval.markApproved")}
                    </Button>
                  </form>
                  <form
                    action={
                      overview.reminderV2Approved ? disableReminderV2Action : enableReminderV2Action
                    }
                  >
                    <input type="hidden" name="organizationId" value={overview.id} />
                    <Button type="submit" variant="secondary" size="sm">
                      {t("owner.organizations.templateApproval.reminderLabel")}:{" "}
                      {overview.reminderV2Approved
                        ? t("owner.organizations.templateApproval.approved")
                        : t("owner.organizations.templateApproval.markApproved")}
                    </Button>
                  </form>
                </div>
              </div>
            )}

            {/* Manual connection form — kept in full, just no longer the
                first thing on the page. Shown expanded when there is no
                healthy connection to speak of. */}
            <div>
              <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-text-muted">
                חיבור WhatsApp ידני
              </h3>
              <p className="mb-3 text-xs text-text-secondary">
                לחיבור עצמאי ללא Embedded Signup. הבדיקה מתבצעת מול Meta לפני השמירה; הטוקן נשמר מוצפן.
              </p>

              {whatsappConnected && (
                <p
                  role="status"
                  className="mb-3 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm font-medium text-success"
                >
                  החיבור בוצע בהצלחה.
                </p>
              )}
              {whatsappError && (
                <p
                  role="alert"
                  className="mb-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
                >
                  {decodeURIComponent(whatsappError)}
                </p>
              )}

              <form action={manuallyConnectWhatsAppAction} className="space-y-3">
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
                <AsyncActionButton idleLabel="בדוק וחבר" pendingLabel="בודק מול Meta…" />
              </form>
            </div>
          </div>
        </CollapsibleSection>
      </div>
    </div>
  );
}
