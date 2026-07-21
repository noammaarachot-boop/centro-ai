import { buttonVariants } from "@/components/app/Button";
import { advanceOnboardingStep } from "../actions";

// No hand — a hand-drawn/CSS 3D hand read as artificial under review, and
// the approved direction is "no hand at all" over one that looks fake.
// Alive comes from typography + motion instead: an ambient glow, then
// eyebrow, then a blur-to-sharp title reveal, then the subtitle, then the
// button rising into place last (see the .centro-welcome-* keyframes).
export function Step1Welcome({ displayName }: { displayName: string }) {
  const goToStep2 = advanceOnboardingStep.bind(null, 2);

  return (
    <div className="relative pt-2 pb-1 text-center">
      <div
        aria-hidden="true"
        className="centro-welcome-glow pointer-events-none absolute -top-9 start-1/2 -z-0 h-[170px] w-[260px] -translate-x-1/2 rounded-full blur-[30px]"
        style={{
          background:
            "radial-gradient(circle, color-mix(in oklab, var(--color-brand-purple) 22%, transparent), transparent 70%)",
        }}
      />
      <p className="centro-welcome-eyebrow centro-ai-gradient-text relative z-[1] mb-3.5 text-[11px] font-extrabold tracking-[0.24em]">
        CENTRO
      </p>
      <h2 className="centro-welcome-title relative z-[1] text-balance text-2xl font-bold text-text-primary">
        ברוכים הבאים, {displayName}!
      </h2>
      <p className="centro-welcome-sub relative z-[1] mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        אנחנו שמחים שהצטרפתם. בדקות הקרובות נכין את Centro לעבוד בדיוק כמו שהעסק שלכם
        עובד — נחבר שירותים, נייבא לקוחות, ונגדיר אילו מסמכים לאסוף ומתי לפנות ללקוחות.
      </p>

      <form action={goToStep2} className="centro-welcome-cta relative z-[1] mt-8">
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          בואו נתחיל
        </button>
      </form>
    </div>
  );
}
