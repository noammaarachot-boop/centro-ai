import { ArrowLeft } from "lucide-react";
import { buttonVariants } from "@/components/app/Button";
import { finishOnboarding } from "../actions";

export function Step9Completion() {
  return (
    <div className="text-center">
      <span className="mx-auto mb-4 grid h-20 w-20 place-items-center rounded-full bg-gradient-to-l from-brand-purple to-brand-blue text-4xl shadow-glow-purple">
        🎉
      </span>
      <h2 className="text-balance text-2xl font-bold text-text-primary">Centro מוכן!</h2>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        הכול מוגדר. העסק שלכם יכול להתחיל לאסוף מסמכים אוטומטית — Centro יפנה ללקוחות,
        יסווג את מה שמתקבל, ויעדכן אתכם לאורך כל הדרך.
      </p>
      <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-text-secondary">
        Centro לא צריך התאמה מושלמת ביום הראשון. ככל שהלקוחות ישלחו מסמכים, Centro ימשיך
        ללמוד את פרופיל איסוף המסמכים של כל לקוח וישפר את בקשות האיסוף הבאות באופן אוטומטי.
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
