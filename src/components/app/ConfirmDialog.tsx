"use client";

import { useId, type ReactNode } from "react";
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
// `trigger`/`triggerClassName` render ConfirmDialog's OWN native <button>
// with the popover-opener attributes already on it — `trigger` is just its
// inner content (icon + label), never a whole element to clone. An earlier
// version accepted a full trigger *element* and used `cloneElement` to
// inject the popover attributes; that broke intermittently (a real,
// reproduced bug — "Element type is invalid" on server render, but only
// for some data, never for a manually-created row) because every real call
// site is an async Server Component page, and React Server Components only
// support passing child/prop JSX into a Client Component to be *rendered
// as-is* — introspecting or cloning it client-side (as `cloneElement`
// does) is not a supported operation on a cross-boundary element.
// Accepting plain `ReactNode` content instead of an `ReactElement` to
// clone sidesteps that entirely.
export function ConfirmDialog({
  trigger,
  triggerClassName,
  title,
  description,
  confirmLabel = "אישור",
  cancelLabel = "ביטול",
  confirmVariant = "danger",
  formAction,
  hiddenFields,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
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
      <button
        type="button"
        popoverTarget={popoverId}
        popoverTargetAction="show"
        className={triggerClassName}
      >
        {trigger}
      </button>
      <div
        popover="auto"
        id={popoverId}
        className="centro-glass-strong m-auto w-full max-w-sm rounded-2xl border border-border p-6 shadow-card-lg backdrop:bg-text-primary/40 backdrop:backdrop-blur-sm"
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="centro-icon-danger grid h-10 w-10 shrink-0 place-items-center rounded-xl">
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
