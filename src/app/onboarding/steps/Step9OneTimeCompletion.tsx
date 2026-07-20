import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { finishOnboarding } from "../actions";

// Workflow B's own completion screen — copy about templates and one-off
// requests rather than automatic recurring collection. Reuses
// finishOnboarding() unchanged: it only activates automation if both
// integrations are connected and marks onboarding complete, neither of
// which is workflow-specific.
export function Step9OneTimeCompletion() {
  return (
    <div className="text-center">
      <span className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-l from-brand-purple to-brand-blue text-4xl shadow-glow-purple">
        🎉
      </span>
      <h2 className="text-balance text-2xl font-bold text-text-primary">Centro מוכן!</h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        המשרד שלכם מוכן ליצור תבניות איסוף מסמכים ולשלוח בקשות ללקוחות בכל עת — עכשיו
        או מתוזמן לתאריך עתידי. Centro ישלח, יעקוב, ויארגן את המסמכים שיתקבלו אוטומטית.
      </p>

      <form action={finishOnboarding} className="mt-8">
        <button
          type="submit"
          className={buttonVariants({ variant: "primary", size: "lg", className: "w-full" })}
        >
          מעבר ללוח הבקרה
          <ArrowLeft className="h-4 w-4" />
        </button>
      </form>

      <p className="mt-4 text-xs text-text-muted">
        אל דאגה — כל הגדרה אפשר לשנות מאוחר יותר דרך ההגדרות.
      </p>
    </div>
  );
}
