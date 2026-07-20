"use client";

import { cloneElement, useId, type ReactElement } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/app/Button";

// A shared confirm step in front of every destructive action in the app
// (delete client/service/template, simulate-Drive-deletion) — none had one
// before. Built on the native Popover API (`popover`/`popoverTarget`/
// `popoverTargetAction` attributes) rather than a ref-driven <dialog> or a
// new dependency: the browser handles top-layer stacking, light-dismiss,
// and Escape-to-close entirely declaratively, with no imperative ref
// (which this project's stricter react-hooks/refs lint rule correctly
// steers away from).
//
// `trigger` is a plain JSX element (not a render-prop function) — every
// real call site is an async Server Component page (client/service/
// template detail pages), and a function prop can't cross the Server-to-
// Client Component boundary (React Server Components can only pass
// serializable props to a "use client" component; an arbitrary closure
// isn't serializable, only a Server Action reference or plain JSX is).
// `cloneElement` injects the popover-opener attributes onto whatever
// static trigger markup the caller passed in. `formAction` is the same
// bound server action every caller already has (e.g.
// `deleteClient.bind(null, id)`); confirming submits it exactly as the
// un-confirmed one-click version did.
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = "אישור",
  cancelLabel = "ביטול",
  confirmVariant = "danger",
  formAction,
  hiddenFields,
}: {
  trigger: ReactElement<{ popoverTarget?: string; popoverTargetAction?: "show" }>;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  formAction: (formData: FormData) => void | Promise<void>;
  hiddenFields?: Record<string, string>;
}) {
  const popoverId = useId();

  return (
    <>
      {cloneElement(trigger, { popoverTarget: popoverId, popoverTargetAction: "show" })}
      <div
        popover="auto"
        id={popoverId}
        className="m-auto w-full max-w-sm rounded-2xl border border-border bg-surface p-6 shadow-card-lg backdrop:bg-text-primary/40 backdrop:backdrop-blur-sm"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <p className="mt-1 text-sm text-text-secondary">{description}</p>
          </div>
        </div>
        <form action={formAction} className="flex items-center justify-end gap-2">
          {hiddenFields &&
            Object.entries(hiddenFields).map(([name, value]) => (
              <input key={name} type="hidden" name={name} value={value} />
            ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            popoverTarget={popoverId}
            popoverTargetAction="hide"
          >
            {cancelLabel}
          </Button>
          <Button type="submit" variant={confirmVariant} size="sm">
            {confirmLabel}
          </Button>
        </form>
      </div>
    </>
  );
}
