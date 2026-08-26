"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, Info, Loader2, MessageCircle, RefreshCw, Send } from "lucide-react";
import { clsx } from "clsx";
import type { AttentionActionState } from "@/app/(app)/collections/conversationActions";
import type { RequestAttentionState } from "@/lib/requestAttentionState";

/**
 * The "what now?" panel for a request that needs the employee.
 *
 * Replaces a stack of independent sentences ("לא ענה", "דורש תשומת לב
 * שלך", "שליחת הודעה נכשלה", "כדאי לבדוק את השיחה למטה") sitting beside a
 * button labelled "הפעלה" that did not address any of them. The structure
 * is fixed at three lines — what happened, what to do, one button — so the
 * answer is always in the same place.
 */

const ICON = {
  danger: AlertTriangle,
  warning: AlertTriangle,
  info: Info,
  none: Info,
} as const;

const ACTION_ICON = {
  retry_send: RefreshCw,
  send_reminder: Send,
  reactivate: Send,
  open_conversation: MessageCircle,
} as const;

function SubmitButton({ label, kind }: { label: string; kind: keyof typeof ACTION_ICON }) {
  const { pending } = useFormStatus();
  const Icon = ACTION_ICON[kind];
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-purple px-4 text-sm font-semibold text-white transition-colors hover:bg-brand-purple-deep disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Icon className="h-4 w-4" aria-hidden="true" />}
      {pending ? "מבצע…" : label}
    </button>
  );
}

export function RequestAttentionPanel({
  state,
  action,
  conversationAnchor = "#conversation",
}: {
  state: RequestAttentionState;
  /** Bound to the request; which action it runs depends on state.primaryAction. */
  action: ((prev: AttentionActionState, formData: FormData) => Promise<AttentionActionState>) | null;
  conversationAnchor?: string;
}) {
  const [result, formAction] = useActionState<AttentionActionState, FormData>(
    action ?? (async () => ({})),
    {}
  );

  if (state.kind === "none") return null;
  const Icon = ICON[state.severity];
  const danger = state.severity === "danger";

  return (
    <div
      className={clsx(
        "mt-4 rounded-2xl border p-4",
        danger ? "border-danger/30 bg-danger/5" : "border-warning/30 bg-warning/5"
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          className={clsx("mt-0.5 h-4.5 w-4.5 shrink-0", danger ? "text-danger" : "text-warning")}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          {/* Line 1 — what happened. */}
          <p className="text-sm font-bold text-text-primary">{state.title}</p>
          {/* Line 2 — what to do now. */}
          <p className="mt-1 text-sm text-text-secondary">{state.guidance}</p>

          {/* Line 3 — the action, and only one that can actually run. */}
          {(state.primaryAction || state.secondaryAction) && (
            <div className="mt-3.5 flex flex-wrap items-center gap-3">
              {state.primaryAction && action && (
                <form action={formAction}>
                  <SubmitButton label={state.primaryAction.label} kind={state.primaryAction.kind} />
                </form>
              )}
              {state.secondaryAction?.kind === "open_conversation" && (
                <a
                  href={conversationAnchor}
                  className="text-sm font-semibold text-text-secondary transition-colors hover:text-brand-purple"
                >
                  {state.secondaryAction.label}
                </a>
              )}
            </div>
          )}

          {/* The outcome of the click, never inferred from the click itself. */}
          {result.success && (
            <p role="status" className="mt-3 text-sm font-medium text-brand-emerald">
              {result.success}
            </p>
          )}
          {result.error && (
            <p role="alert" className="mt-3 text-sm font-medium text-danger">
              {result.error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
