"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Check, Loader2 } from "lucide-react";
import type { DismissAttentionState } from "@/app/(app)/dashboard/attentionActions";

/**
 * "טופל" — marks one attention item as handled by a human.
 *
 * Deliberately small. This is not a task system: it records that somebody
 * dealt with this and removes the row, and it changes nothing about the
 * request, the documents or the client's state.
 *
 * The confirm step is one inline click, not a dialog — the action is
 * recoverable (the same condition raises a fresh item if it recurs) so a
 * modal would cost more than the mistake it prevents, but a bare one-click
 * "make this disappear" next to a link is too easy to hit by accident.
 */
function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-emerald/30 bg-brand-emerald/10 px-3 py-2 text-[12.5px] font-bold whitespace-nowrap text-brand-emerald transition-colors hover:bg-brand-emerald/20 disabled:opacity-60"
    >
      {pending ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      {pending ? "מסמן…" : label}
    </button>
  );
}

export function DismissAttentionButton({
  action,
}: {
  action: (prev: DismissAttentionState, formData: FormData) => Promise<DismissAttentionState>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction] = useActionState<DismissAttentionState, FormData>(action, {});

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="shrink-0 rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] font-bold whitespace-nowrap text-text-secondary transition-colors hover:border-brand-emerald/40 hover:text-brand-emerald"
      >
        טופל
      </button>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <form action={formAction}>
        <Submit label="אישור" />
      </form>
      <button
        type="button"
        onClick={() => setConfirming(false)}
        className="rounded-lg px-2 py-2 text-[12.5px] font-semibold text-text-muted transition-colors hover:text-text-primary"
      >
        ביטול
      </button>
      {state.error && (
        <span role="alert" className="text-[12px] font-medium text-danger">
          {state.error}
        </span>
      )}
    </div>
  );
}
