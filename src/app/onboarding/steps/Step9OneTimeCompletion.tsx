import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { CelebrationBadge } from "@/components/app/CelebrationBadge";
import { finishOnboarding } from "../actions";

// Workflow B's own completion screen — copy about Collection Requests and
// one-off sends rather than automatic recurring collection.
// finishOnboarding() itself is workflow-aware now (see its own comment in
// actions.ts): it no longer requires WhatsApp/Drive to be connected for
// this flow specifically, since that happens for the first time inside the
// Collection Requests wizard, right before the first send.
export function Step9OneTimeCompletion() {
  return (
    <div className="text-center">
      <CelebrationBadge />
      <h2 className="text-balance text-2xl font-bold text-text-primary">Centro מוכן!</h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        העסק שלכם מוכן ליצור בקשות איסוף מסמכים ולשלוח אותן ללקוחות בכל עת — עכשיו
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
