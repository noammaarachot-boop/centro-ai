"use client";

import { useId, type ReactNode } from "react";
import { X } from "lucide-react";

// A side panel, built on the same native Popover API as ConfirmDialog.tsx
// (no external modal library, no imperative ref) — the browser handles
// top-layer stacking, light-dismiss, and Escape-to-close declaratively.
// Positioned at the inline-end edge (left, in this RTL app) rather than
// ConfirmDialog's centered layout, since the Sidebar already occupies the
// right edge.
export function Drawer({
  trigger,
  triggerClassName,
  title,
  children,
}: {
  trigger: ReactNode;
  triggerClassName?: string;
  title: string;
  children: ReactNode;
}) {
  const popoverId = useId();

  return (
    <>
      <button type="button" popoverTarget={popoverId} popoverTargetAction="show" className={triggerClassName}>
        {trigger}
      </button>
      <div
        popover="auto"
        id={popoverId}
        className="centro-glass-strong fixed inset-y-0 end-0 m-0 h-dvh w-full max-w-md rounded-none border-0 border-s border-border p-0 shadow-card-lg backdrop:bg-text-primary/40 backdrop:backdrop-blur-sm"
      >
        <div className="flex h-full flex-col p-6">
          <div className="mb-5 flex shrink-0 items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">{title}</h2>
            <button
              type="button"
              popoverTarget={popoverId}
              popoverTargetAction="hide"
              aria-label="סגירה"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-text-muted transition-colors hover:bg-surface-muted hover:text-text-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </div>
      </div>
    </>
  );
}
