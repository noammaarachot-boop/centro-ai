"use client";

import { useActionState } from "react";
import { PlayCircle } from "lucide-react";
import { runSchedulerNow, type RunSchedulerState } from "./actions";
import { Card } from "@/components/app/Card";
import { Button } from "@/components/app/Button";

const initialState: RunSchedulerState = {};

export function RunSchedulerButton() {
  const [state, formAction, isPending] = useActionState(
    runSchedulerNow,
    initialState
  );

  return (
    <form action={formAction}>
      <Card>
        <h2 className="mb-1 text-lg font-semibold text-text-primary">משימות מתוזמנות</h2>
        <p className="mb-4 text-sm text-text-muted">
          עד לחיבור cron חיצוני (POST /api/cron/tick), ניתן להריץ ידנית: הערכת שיחות
          שקטות ושליחת תזכורות.
        </p>
        <Button type="submit" variant="secondary" loading={isPending}>
          <PlayCircle className="h-4 w-4" />
          הרצה עכשיו
        </Button>
        {state.result && (
          <p className="mt-3 animate-fade-in-up text-xs text-text-muted">
            {state.result.evaluated} שיחות הוערכו, {state.result.reminded} תזכורות נשלחו,{" "}
            {state.result.delivered} בקשות מתוזמנות נשלחו.
          </p>
        )}
      </Card>
    </form>
  );
}
