import { Clock, Sparkles } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { advanceOnboardingStep } from "../actions";

export function Step1Welcome({ displayName }: { displayName: string }) {
  const goToStep2 = advanceOnboardingStep.bind(null, 2);

  return (
    <div className="text-center">
      <span className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-l from-brand-purple to-brand-blue text-3xl shadow-glow-purple">
        👋
      </span>
      <h2 className="text-balance text-2xl font-bold text-text-primary">
        ברוכים הבאים, {displayName}!
      </h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        אנחנו שמחים שהצטרפתם. בדקות הקרובות נכין את Centro לעבוד בדיוק כמו שהמשרד שלכם
        עובד — נחבר שירותים, נייבא לקוחות, ונגדיר אילו מסמכים לאסוף ומתי לפנות ללקוחות.
      </p>

      <div className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface-muted px-4 py-2 text-sm font-medium text-text-secondary">
        <Clock className="h-4 w-4 text-brand-purple" />
        זמן הקמה משוער: כ-3 דקות
      </div>

      <form action={goToStep2} className="mt-8">
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          <Sparkles className="h-4 w-4" />
          בואו נתחיל
        </button>
      </form>
    </div>
  );
}
