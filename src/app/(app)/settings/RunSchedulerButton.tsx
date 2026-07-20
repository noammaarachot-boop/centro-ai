"use client";

import { useActionState } from "react";
import { PlayCircle } from "lucide-react";
import { runSchedulerNow, type RunSchedulerState } from "./actions";
import { Button } from "@/components/app/Button";

const initialState: RunSchedulerState = {};

// Rendered inside Settings' DevToolsPanel, which already supplies the
// dashed-border framing and the "משימות מתוזמנות" disclosure label - no
// need for this component's own Card/heading on top of that.
export function RunSchedulerButton() {
  const [state, formAction, isPending] = useActionState(
    runSchedulerNow,
    initialState
  );

  return (
    <form action={formAction}>
      <p className="mb-3 text-xs text-text-muted">
        עד לחיבור cron חיצוני (POST /api/cron/tick), ניתן להריץ ידנית: הערכת שיחות שקטות
        ושליחת תזכורות.
      </p>
      <Button type="submit" variant="secondary" size="sm" loading={isPending}>
        <PlayCircle className="h-4 w-4" />
        הרצה עכשיו
      </Button>
      {state.result && (
        <p className="mt-3 animate-fade-in-up text-xs text-text-muted">
          {state.result.evaluated} שיחות הוערכו, {state.result.reminded} תזכורות נשלחו,{" "}
          {state.result.delivered} בקשות מתוזמנות נשלחו.
        </p>
      )}
    </form>
  );
}
