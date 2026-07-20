import { CheckCircle2, Circle, HardDrive, MessageCircle } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import {
  advanceOnboardingStep,
  connectGoogle,
  connectWhatsapp,
  disconnectGoogle,
  disconnectWhatsapp,
} from "../actions";

function ConnectionRow({
  icon: Icon,
  label,
  explanation,
  connectedAt,
  connectAction,
  disconnectAction,
}: {
  icon: typeof HardDrive;
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
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-purple/10 text-brand-purple">
            <Icon className="h-4.5 w-4.5" />
          </span>
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-semibold text-text-primary">{label}</p>
              {isConnected ? (
                <CheckCircle2 className="h-4 w-4 text-brand-emerald" />
              ) : (
                <Circle className="h-4 w-4 text-text-muted" />
              )}
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
        icon={HardDrive}
        label="Google Drive"
        explanation="כל מסמך שמאושר עבור לקוח מאוחסן אוטומטית בתיקייה משלו בגוגל דרייב של המשרד — מסודר ונגיש בלי עבודה ידנית."
        connectedAt={googleConnectedAt}
        connectAction={connectGoogle}
        disconnectAction={disconnectGoogle}
      />
      <ConnectionRow
        icon={MessageCircle}
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
