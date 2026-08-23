"use client";

import { useFormStatus } from "react-dom";
import { Check, Loader2, X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/app/Button";

// A submit button that reports what is actually happening, instead of the
// page silently reloading. The pending state comes from useFormStatus, so
// it reflects the REAL in-flight server action rather than a timer or an
// optimistic guess — there is no simulated progress here.
//
// Success/failure are passed in by the parent from persisted state, so the
// result survives the redirect that follows the action and a later page
// refresh, rather than vanishing the moment the form re-renders.
export function AsyncActionButton({
  idleLabel,
  pendingLabel,
  outcome,
  variant = "primary",
  size = "sm",
  icon,
}: {
  idleLabel: string;
  pendingLabel: string;
  /** Result of the last completed run, or null when it has not been run. */
  outcome?: { ok: boolean; message: string } | null;
  variant?: "primary" | "secondary";
  size?: "sm" | "md";
  icon?: ReactNode;
}) {
  const { pending } = useFormStatus();

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Button type="submit" variant={variant} size={size} disabled={pending}>
        {pending ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            {pendingLabel}
          </>
        ) : (
          <>
            {icon}
            {idleLabel}
          </>
        )}
      </Button>

      {/* Only ever shown once the action has genuinely finished. */}
      {!pending && outcome && (
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
            outcome.ok ? "text-success" : "text-danger"
          }`}
        >
          {outcome.ok ? (
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <X className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {outcome.message}
        </span>
      )}
    </div>
  );
}
