"use client";

import { HelpCircle } from "lucide-react";
import { clsx } from "clsx";
import { Popover } from "@/components/app/Popover";

// Reusable "Why is this important?" / "What does this do?" popover, used by
// every onboarding step, Settings, and the service screens.
//
// The panel itself is now Popover (native top layer), which fixed three real
// bugs this component had:
//   • it was `absolute z-20` inside a `relative` wrapper, so any ancestor
//     with overflow-hidden clipped it — Table sets exactly that, so every
//     help tip inside a table was cut off;
//   • a sibling card forming a stacking context could cover it;
//   • it was pinned `start-0 mt-2`, so near the bottom or edge of the
//     viewport it opened off-screen with no way to read it.
//
// The public API is unchanged, so all existing call sites keep working.
export function HelpTip({
  label = "למה זה חשוב?",
  children,
  className,
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Popover
      triggerClassName={clsx(
        "inline-flex items-center gap-1.5 rounded-full text-xs font-medium text-brand-purple transition-colors hover:text-brand-purple-deep",
        // The label alone renders ~16px tall, which the responsive smoke test
        // flagged as a real control that is hard to hit with a thumb. The
        // padding doubles the tap area to ~32px; the matching negative margin
        // keeps it from shifting the labels it sits beside, so this buys
        // touch reach without changing any layout.
        "py-2 -my-2",
        className
      )}
      trigger={
        <>
          <HelpCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {label}
        </>
      }
      panelClassName="text-xs leading-relaxed text-text-secondary"
    >
      {children}
    </Popover>
  );
}
