import { CheckCircle2, Circle } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { updateBusinessHours } from "./actions";
import { activateAutomation, deactivateAutomation } from "../../onboarding/actions";
import { RunSchedulerButton } from "./RunSchedulerButton";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { OfficeInfoForm } from "@/components/app/OfficeInfoForm";
import { HelpTip } from "@/components/app/HelpTip";
import { CollectionDayField } from "@/components/app/CollectionDayField";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await requireSession();
  const { error } = await searchParams;
  const organization = await getOrganization(session.organizationId);
  if (!organization) return null;

  const activeDays = new Set(organization.businessDays.split(",").map(Number));
  const isAutomationActive = !!organization.automationActivatedAt;
  const integrationsReady = !!organization.googleConnectedAt && !!organization.whatsappConnectedAt;

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        title="הגדרות"
        description="שעות פעילות וימי עבודה קובעים מתי Centro שולח הודעות אוטומטיות (BR-18.1)."
      />

      {error === "integrations-required" && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business (עמוד הקמת המערכת).
        </p>
      )}

      <Card>
        <h2 className="mb-4 text-lg font-semibold text-text-primary">פרטי העסק</h2>
        <OfficeInfoForm
          name={organization.name}
          logoUrl={organization.logoUrl}
          returnTo="/settings"
          submitLabel="שמירת פרטי העסק"
        />
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {isAutomationActive ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-emerald" />
            ) : (
              <Circle className="h-5 w-5 shrink-0 text-text-muted" />
            )}
            <div>
              <p className="text-sm font-semibold text-text-primary">אוטומציה</p>
              <p className="text-xs text-text-muted">
                {isAutomationActive
                  ? "האוטומציה פעילה — Centro פונה ללקוחות ומעבד מסמכים אוטומטית."
                  : "האוטומציה כבויה. יש לחבר Google ו-WhatsApp Business כדי להפעיל."}
              </p>
            </div>
          </div>
          <form action={isAutomationActive ? deactivateAutomation : activateAutomation}>
            <button
              type="submit"
              disabled={!integrationsReady && !isAutomationActive}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              {isAutomationActive ? "השבתה" : "הפעלה"}
            </button>
          </form>
        </div>
      </Card>

      <form action={updateBusinessHours}>
        <Card className="space-y-5">
          <div>
            <p className="mb-2 text-sm font-medium text-text-secondary">ימי עבודה</p>
            <div className="flex flex-wrap gap-3">
              {DAY_LABELS.map((label, day) => (
                <label
                  key={day}
                  className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-muted/40 px-3 py-1.5 text-sm text-text-primary transition-colors hover:border-brand-purple/30"
                >
                  <input
                    type="checkbox"
                    name={`day-${day}`}
                    defaultChecked={activeDays.has(day)}
                    className="h-4 w-4 rounded border-border accent-brand-purple"
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="businessHoursStart"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                שעת התחלה
              </label>
              <input
                id="businessHoursStart"
                name="businessHoursStart"
                type="time"
                defaultValue={organization.businessHoursStart}
                dir="ltr"
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
            <div>
              <label
                htmlFor="businessHoursEnd"
                className="mb-1.5 block text-sm font-medium text-text-secondary"
              >
                שעת סיום
              </label>
              <input
                id="businessHoursEnd"
                name="businessHoursEnd"
                type="time"
                defaultValue={organization.businessHoursEnd}
                dir="ltr"
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="reminderIntervalDays"
                className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary"
              >
                מרווח תזכורות (ימים)
                <HelpTip label="">
                  אם הלקוח לא הגיב, Centro ישלח תזכורת נוספת אוטומטית כל X ימים.
                </HelpTip>
              </label>
              <input
                id="reminderIntervalDays"
                name="reminderIntervalDays"
                type="number"
                min={1}
                defaultValue={organization.reminderIntervalDays}
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
            <div>
              <label
                htmlFor="inactivityTimeoutMinutes"
                className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary"
              >
                זמן חוסר פעילות (דקות)
                <HelpTip label="">
                  אם הלקוח מפסיק לשלוח מסמכים למשך כך הרבה דקות, Centro מניח שסיים בינתיים
                  ושואל אם יש מסמכים נוספים.
                </HelpTip>
              </label>
              <input
                id="inactivityTimeoutMinutes"
                name="inactivityTimeoutMinutes"
                type="number"
                min={1}
                defaultValue={organization.inactivityTimeoutMinutes}
                className="w-full rounded-xl border border-border bg-white px-3 py-2.5 text-sm text-text-primary outline-none transition-all duration-200 focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
            </div>
          </div>

          <CollectionDayField defaultValue={organization.collectionDayOfMonth} />

          <button type="submit" className={buttonVariants({ variant: "primary", size: "lg" })}>
            שמירת הגדרות
          </button>
        </Card>
      </form>

      <RunSchedulerButton />
    </div>
  );
}
