import { CheckCircle2, Circle } from "lucide-react";
import { requireSession } from "@/lib/auth/session";
import { getGoogleDriveConnectionStatus, getOrganization } from "@/lib/data/organizations";
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
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { OfficeInfoForm } from "@/components/app/OfficeInfoForm";
import { HelpTip } from "@/components/app/HelpTip";
import { BusinessHoursForm } from "@/components/app/BusinessHoursForm";
import { DevToolsPanel } from "@/components/app/DevToolsPanel";
import { devToolsEnabled } from "@/lib/devTools";

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

  const isDocumentCollectionActive = organization.documentCollectionEnabled;
  const whatsappConnected = !!organization.whatsappConnectedAt;
  // WhatsApp deliberately stays existence-only (!!whatsappConnectedAt,
  // in WhatsAppConnectionRow itself) — no reliable connection-level
  // failure signal exists for it today (send failures are per-message,
  // not "the connection itself is broken" the way a Google token-refresh
  // failure unambiguously is). Google Drive gets the real signal below.
  const googleConnectionStatus = await getGoogleDriveConnectionStatus(
    session.organizationId,
    organization.googleConnectedAt
  );

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
          needsReconnect={googleConnectionStatus === "needs_reconnect"}
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
          {isDocumentCollectionActive ? (
            <ConfirmDialog
              title="להשבית איסוף מסמכים אוטומטי?"
              description="לא יישלחו תזכורות ומעקבים אוטומטיים ולא ייווצרו מחזורי איסוף חדשים. עדיין ניתן יהיה לבצע פעולות ידניות."
              confirmLabel="השבתת האוטומציה"
              cancelLabel="ביטול"
              formAction={disableDocumentCollection}
              triggerClassName={buttonVariants({ variant: "secondary", size: "sm" })}
              trigger="השבתה"
            />
          ) : (
            <form action={enableDocumentCollection}>
              <button
                type="submit"
                disabled={!whatsappConnected}
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                הפעלה
              </button>
            </form>
          )}
        </div>
      </Card>

      <Card className="space-y-5">
        <BusinessHoursForm
          organization={{
            businessDays: organization.businessDays,
            businessHoursStart: organization.businessHoursStart,
            businessHoursEnd: organization.businessHoursEnd,
            timezone: organization.timezone,
            reminderIntervalHours: organization.reminderIntervalHours,
          }}
        />
      </Card>

      {/* Development-only. The action behind it is independently gated
          server-side (settings/actions.ts), so not rendering here is a
          convenience — not the security boundary. */}
      {devToolsEnabled() && (
        <DevToolsPanel label="משימות מתוזמנות">
          <RunSchedulerButton />
        </DevToolsPanel>
      )}
    </div>
  );
}
