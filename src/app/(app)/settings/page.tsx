import { CheckCircle2, Circle } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import { updateBusinessHours } from "./actions";
import {
  enableDocumentCollection,
  disableDocumentCollection,
} from "../../onboarding/actions";
import {
  GoogleDriveConnectionRow,
  WhatsAppConnectionRow,
} from "../../onboarding/steps/Step3Connect";
import { RunSchedulerButton } from "./RunSchedulerButton";
import { PageHeader } from "@/components/app/PageHeader";
import { Card } from "@/components/app/Card";
import { buttonVariants } from "@/components/app/Button";
import { OfficeInfoForm } from "@/components/app/OfficeInfoForm";
import { HelpTip } from "@/components/app/HelpTip";
import { CollectionDayField } from "@/components/app/CollectionDayField";
import { fieldClass } from "@/components/app/FormField";
import { DevToolsPanel } from "@/components/app/DevToolsPanel";

const DAY_LABELS = ["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "ש׳"];

const SETTINGS_ERROR_MESSAGES: Record<string, string> = {
  "integrations-required": "לא ניתן להפעיל אוטומציה לפני חיבור Google ו-WhatsApp Business.",
  "whatsapp-required": "יש לחבר WhatsApp Business כדי להפעיל איסוף מסמכים אוטומטי.",
  "google-denied": "החיבור לחשבון Google בוטל.",
  "google-invalid-state": "אימות החיבור לחשבון Google נכשל. נסו לחבר שוב.",
  "google-oauth-failed": "החיבור לחשבון Google נכשל. נסו שוב בעוד רגע.",
  "google-not-configured": "חיבור Google אינו זמין כרגע. פנו לתמיכה.",
  "google-folder-failed": "בחירת/יצירת התיקייה ב-Drive נכשלה. נסו שוב.",
};

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
  const isDocumentCollectionActive = organization.documentCollectionEnabled;
  const whatsappConnected = !!organization.whatsappConnectedAt;

  return (
    <div className="mx-auto max-w-lg animate-fade-in-up space-y-6 px-6 py-10 lg:px-10">
      <PageHeader
        title="הגדרות"
        description="שעות פעילות וימי עבודה קובעים מתי Centro שולח הודעות אוטומטיות."
      />

      {error && SETTINGS_ERROR_MESSAGES[error] && (
        <p
          role="alert"
          className="animate-fade-in-up rounded-xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm font-medium text-danger"
        >
          {SETTINGS_ERROR_MESSAGES[error]}
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

      <Card className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">חיבורים</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-secondary">
            שני החיבורים הבאים הכרחיים כדי ש-Centro יוכל לפעול: WhatsApp משמש לתקשורת עם
            הלקוחות — פנייה ראשונית, תזכורות וקבלת מסמכים; Google Drive הוא יעד האחסון של
            המסמכים שהתקבלו. בלי שניהם מחוברים, לא ניתן להתחיל איסוף חדש.
          </p>
        </div>
        <GoogleDriveConnectionRow
          googleConnectedAt={organization.googleConnectedAt}
          googleDriveFolderId={organization.googleDriveFolderId}
          googleDriveFolderName={organization.googleDriveFolderName}
          connectReturnTo="/settings"
        />
        <WhatsAppConnectionRow
          whatsappConnectedAt={organization.whatsappConnectedAt}
          whatsappDisplayPhoneNumber={organization.whatsappDisplayPhoneNumber}
        />
      </Card>

      <Card>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            {isDocumentCollectionActive ? (
              <CheckCircle2 className="h-5 w-5 shrink-0 text-brand-emerald" />
            ) : (
              <Circle className="h-5 w-5 shrink-0 text-text-muted" />
            )}
            <div>
              <div className="flex items-center gap-1">
                <p className="text-sm font-semibold text-text-primary">איסוף מסמכים אוטומטי</p>
                <HelpTip label="מה זה עושה?">
                  כאשר מופעל, Centro פונה ללקוחות ומעבד את המסמכים הנכנסים אוטומטית: שולח את
                  בקשת המסמכים, מזהה ומשייך כל מסמך שמתקבל, ומעדכן מה עוד חסר.
                  <br />
                  <br />
                  כיבוי עוצר רק את הפעילות האוטומטית — לא ייפתחו מחזורי איסוף חדשים ולא יישלחו
                  הודעות או תזכורות אוטומטיות.
                  <br />
                  <br />
                  שליחה ידנית תמיד ממשיכה לעבוד, בין אם זה מופעל ובין אם לא. שום מידע לא נמחק.
                </HelpTip>
              </div>
              <p className="text-xs text-text-muted">
                {isDocumentCollectionActive
                  ? "איסוף המסמכים האוטומטי פעיל — Centro פונה ללקוחות ומעבד מסמכים אוטומטית."
                  : whatsappConnected
                    ? "איסוף המסמכים האוטומטי כבוי. שליחה ידנית עדיין עובדת."
                    : "יש לחבר WhatsApp Business כדי להפעיל איסוף מסמכים אוטומטי."}
              </p>
            </div>
          </div>
          <form action={isDocumentCollectionActive ? disableDocumentCollection : enableDocumentCollection}>
            <button
              type="submit"
              disabled={!whatsappConnected && !isDocumentCollectionActive}
              className={buttonVariants({ variant: "secondary", size: "sm" })}
            >
              {isDocumentCollectionActive ? "השבתה" : "הפעלה"}
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
                className={fieldClass("md")}
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
                className={fieldClass("md")}
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="timezone"
              className="mb-1.5 flex items-center gap-1 text-sm font-medium text-text-secondary"
            >
              אזור זמן
              <HelpTip label="">שעות הפעילות למעלה נמדדות לפי אזור הזמן הזה, לא לפי שעון השרת.</HelpTip>
            </label>
            <select
              id="timezone"
              name="timezone"
              defaultValue={organization.timezone}
              dir="ltr"
              className={fieldClass("md")}
            >
              <option value="Asia/Jerusalem">שעון ישראל (Asia/Jerusalem)</option>
              <option value="UTC">UTC</option>
            </select>
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
                className={fieldClass("md")}
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
                className={fieldClass("md")}
              />
            </div>
          </div>

          {/* Product Evolution M9 — every organization can create a
              Recurring Collection at any time now (not gated by the
              initial onboarding choice), so this default anchor day is
              always relevant, not just for orgs that started as
              "recurring". */}
          <CollectionDayField defaultValue={organization.collectionDayOfMonth} />

          <button type="submit" className={buttonVariants({ variant: "primary", size: "lg" })}>
            שמירת הגדרות
          </button>
        </Card>
      </form>

      <DevToolsPanel label="משימות מתוזמנות">
        <RunSchedulerButton />
      </DevToolsPanel>
    </div>
  );
}
