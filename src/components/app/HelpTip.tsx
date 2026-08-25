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
        // Tap area only. Padding grows the hit box, the equal negative
        // margin cancels it out of the margin box, so the trigger occupies
        // exactly the same space on screen as it did with no padding at
        // all — nothing beside it moves.
        //
        // Both axes, because several call sites pass label="" (see
        // BusinessHoursForm and ServiceScheduleOverrideCard), which renders
        // the icon alone: a 14px-wide target measured at 14x30 on a phone.
        // 9px vertical rather than 8 puts the icon-only case at 32px, the
        // threshold the responsive smoke test holds controls to.
        "px-2 -mx-2 py-[9px] -my-[9px]",
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
