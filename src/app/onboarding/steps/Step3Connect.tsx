import { FolderPlus } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { GoogleDriveMark, WhatsAppMark } from "@/components/app/BrandMarks";
import { GoogleDriveFolderPicker } from "@/components/app/GoogleDriveFolderPicker";
import { WhatsAppConnectButton } from "@/components/app/WhatsAppConnectButton";
import {
  advanceOnboardingStep,
  createGoogleDriveFolder,
  disconnectGoogleDrive,
  disconnectWhatsapp,
} from "../actions";

// WhatsApp's row has a real connection flow (Meta Embedded Signup, a
// client-side popup — not a plain form action) instead of the old mocked
// connect button, so it gets its own row like GoogleDriveConnectionRow
// rather than sharing the generic ConnectionRow other future integrations
// might still use.
function WhatsAppConnectionRow({
  whatsappConnectedAt,
  whatsappDisplayPhoneNumber,
}: {
  whatsappConnectedAt: Date | null;
  whatsappDisplayPhoneNumber: string | null;
}) {
  const isConnected = !!whatsappConnectedAt;
  return (
    <div className="rounded-xl border border-border bg-surface-muted/40 p-4 transition-colors hover:border-brand-purple/20">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border bg-white">
            <WhatsAppMark size={22} />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-text-primary">WhatsApp Business</p>
              {isConnected && <AnimatedCheckBadge key={whatsappConnectedAt!.toISOString()} size={16} />}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              Centro פונה ללקוחות ומקבל מהם מסמכים ישירות בוואטסאפ — בלי שתצטרכו לשלוח הודעה אחת בעצמכם.
            </p>
            {isConnected && (
              <p className="mt-1 text-xs text-text-muted">
                מספר מחובר: {whatsappDisplayPhoneNumber ?? "—"}
              </p>
            )}
          </div>
        </div>
        {!isConnected && <WhatsAppConnectButton />}
        {isConnected && (
          <form action={disconnectWhatsapp}>
            <button
              type="submit"
              className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
            >
              ניתוק
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// Google Drive's row has a third state a generic ConnectionRow can't
// express: connected but no folder chosen yet. Real OAuth (a link to
// /api/auth/google/start, not a form action — it ends in a full-page
// redirect to accounts.google.com) replaces the old mocked connect
// button; once googleConnectedAt is set but no folder is selected, this
// renders the choose-a-folder UI instead of a checkmark.
function GoogleDriveConnectionRow({
  googleConnectedAt,
  googleDriveFolderId,
  googleDriveFolderName,
}: {
  googleConnectedAt: Date | null;
  googleDriveFolderId: string | null;
  googleDriveFolderName: string | null;
}) {
  const isConnected = !!googleConnectedAt;
  const hasFolder = isConnected && !!googleDriveFolderId;

  return (
    <div className="rounded-xl border border-border bg-surface-muted/40 p-4 transition-colors hover:border-brand-purple/20">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border bg-white">
            <GoogleDriveMark size={18} />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-text-primary">Google Drive</p>
              {hasFolder && <AnimatedCheckBadge key={googleConnectedAt!.toISOString()} size={16} />}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              כל מסמך שמאושר עבור לקוח מאוחסן אוטומטית בתיקייה משלו בגוגל דרייב של העסק — מסודר ונגיש בלי
              עבודה ידנית.
            </p>
            {hasFolder && (
              <p className="mt-1 text-xs text-text-muted">תיקייה מחוברת: {googleDriveFolderName}</p>
            )}
          </div>
        </div>
        {!isConnected && (
          <a
            href="/api/auth/google/start"
            className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
          >
            חיבור
          </a>
        )}
        {hasFolder && (
          <form action={disconnectGoogleDrive}>
            <button
              type="submit"
              className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
            >
              ניתוק
            </button>
          </form>
        )}
      </div>

      {isConnected && !hasFolder && (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium text-text-secondary">
            חשבון Google חובר. בחרו תיקייה קיימת ב-Drive או צרו תיקייה חדשה — Centro יעבוד רק בתוכה.
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <GoogleDriveFolderPicker />
            <form action={createGoogleDriveFolder} className="flex items-center gap-1.5">
              <input
                type="text"
                name="name"
                required
                placeholder="שם לתיקייה חדשה"
                className="rounded-full border border-border bg-white px-3 py-2 text-xs text-text-primary outline-none transition-all focus:border-brand-purple focus:ring-4 focus:ring-brand-purple/10"
              />
              <button
                type="submit"
                className={buttonVariants({ variant: "secondary", size: "sm" })}
              >
                <FolderPlus className="h-3.5 w-3.5" />
                יצירת תיקייה
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export function Step3Connect({
  googleConnectedAt,
  googleDriveFolderId,
  googleDriveFolderName,
  whatsappConnectedAt,
  whatsappDisplayPhoneNumber,
}: {
  googleConnectedAt: Date | null;
  googleDriveFolderId: string | null;
  googleDriveFolderName: string | null;
  whatsappConnectedAt: Date | null;
  whatsappDisplayPhoneNumber: string | null;
}) {
  const goToStep4 = advanceOnboardingStep.bind(null, 6);

  return (
    <div className="space-y-4">
      <GoogleDriveConnectionRow
        googleConnectedAt={googleConnectedAt}
        googleDriveFolderId={googleDriveFolderId}
        googleDriveFolderName={googleDriveFolderName}
      />
      <WhatsAppConnectionRow
        whatsappConnectedAt={whatsappConnectedAt}
        whatsappDisplayPhoneNumber={whatsappDisplayPhoneNumber}
      />

      <form action={goToStep4} className="pt-2">
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          המשך
        </button>
      </form>
    </div>
  );
}
