"use client";

import { useActionState } from "react";
import { Loader2, PlayCircle } from "lucide-react";
import { runSchedulerNow, type RunSchedulerState } from "./actions";

const initialState: RunSchedulerState = {};

export function RunSchedulerButton() {
  const [state, formAction, isPending] = useActionState(
    runSchedulerNow,
    initialState
  );

  return (
    <form action={formAction} className="rounded-2xl border border-border bg-surface p-6 shadow-card">
      <h2 className="mb-1 text-lg font-semibold text-text-primary">
        משימות מתוזמנות
      </h2>
      <p className="mb-4 text-sm text-text-muted">
        עד לחיבור cron חיצוני (POST /api/cron/tick), ניתן להריץ ידנית: הערכת
        שיחות שקטות ושליחת תזכורות.
      </p>
      <button
        type="submit"
        disabled={isPending}
        className="flex items-center gap-2 rounded-full border border-border px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-brand-purple hover:text-brand-purple disabled:opacity-70"
      >
        {isPending ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <PlayCircle className="h-4 w-4" />
        )}
        הרצה עכשיו
      </button>
      {state.result && (
        <p className="mt-3 text-xs text-text-muted">
          {state.result.evaluated} שיחות הוערכו, {state.result.reminded} תזכורות נשלחו.
        </p>
      )}
    </form>
  );
}
