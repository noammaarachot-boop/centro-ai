import { buttonVariants } from "@/components/app/Button";
import { AnimatedCheckBadge } from "@/components/app/AnimatedCheckBadge";
import { GoogleDriveMark, WhatsAppMark } from "@/components/app/BrandMarks";
import {
  advanceOnboardingStep,
  connectGoogle,
  connectWhatsapp,
  disconnectGoogle,
  disconnectWhatsapp,
} from "../actions";

function ConnectionRow({
  mark,
  label,
  explanation,
  connectedAt,
  connectAction,
  disconnectAction,
}: {
  mark: React.ReactNode;
  label: string;
  explanation: string;
  connectedAt: Date | null;
  connectAction: () => Promise<void>;
  disconnectAction: () => Promise<void>;
}) {
  const isConnected = !!connectedAt;
  return (
    <div className="rounded-xl border border-border bg-surface-muted/40 p-4 transition-colors hover:border-brand-purple/20">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-border bg-white">
            {mark}
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-text-primary">{label}</p>
              {isConnected && <AnimatedCheckBadge key={connectedAt!.toISOString()} size={16} />}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">{explanation}</p>
            {isConnected && (
              <p className="mt-1 text-xs text-text-muted">
                חובר ב-{connectedAt!.toLocaleDateString("he-IL")}
              </p>
            )}
          </div>
        </div>
        <form action={isConnected ? disconnectAction : connectAction}>
          <button
            type="submit"
            className={buttonVariants({ variant: "secondary", size: "sm", className: "shrink-0" })}
          >
            {isConnected ? "ניתוק" : "חיבור"}
          </button>
        </form>
      </div>
    </div>
  );
}

export function Step3Connect({
  googleConnectedAt,
  whatsappConnectedAt,
}: {
  googleConnectedAt: Date | null;
  whatsappConnectedAt: Date | null;
}) {
  const goToStep4 = advanceOnboardingStep.bind(null, 6);

  return (
    <div className="space-y-4">
      <ConnectionRow
        mark={<GoogleDriveMark size={18} />}
        label="Google Drive"
        explanation="כל מסמך שמאושר עבור לקוח מאוחסן אוטומטית בתיקייה משלו בגוגל דרייב של העסק — מסודר ונגיש בלי עבודה ידנית."
        connectedAt={googleConnectedAt}
        connectAction={connectGoogle}
        disconnectAction={disconnectGoogle}
      />
      <ConnectionRow
        mark={<WhatsAppMark size={22} />}
        label="WhatsApp Business"
        explanation="Centro פונה ללקוחות ומקבל מהם מסמכים ישירות בוואטסאפ — בלי שתצטרכו לשלוח הודעה אחת בעצמכם."
        connectedAt={whatsappConnectedAt}
        connectAction={connectWhatsapp}
        disconnectAction={disconnectWhatsapp}
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
