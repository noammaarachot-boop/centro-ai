import { Popover } from "@/components/app/Popover";

// Dashboard-only — a quiet signal that Centro is continuously watching the
// business, not a functional control.
//
// The explanation used to be a CSS-only :hover tooltip, which meant nobody
// on a touch device could ever read it (there is no hover on a phone) and
// nobody using a keyboard could either — the wrapper held no focusable
// element, so the :focus-within it claimed to support could never fire. It
// was also pinned `left-0`, a physical direction that points the wrong way
// in this app's RTL layout.
//
// It is now a real button with a Popover panel: same pill, same quiet look,
// but reachable by tap and by keyboard, and positioned against the viewport
// so it cannot be clipped.
export function CentroStatusIndicator() {
  return (
    <Popover
      role="tooltip"
      width={230}
      triggerLabel="מה המשמעות של סנטרו פעיל"
      triggerClassName="centro-glass group inline-flex shrink-0 items-center gap-2 rounded-full border border-border py-[7px] ps-[10px] pe-[13px]"
      panelClassName="!bg-text-primary !border-transparent text-[11.5px] leading-[1.5] text-[#f1eefb]"
      trigger={
        <>
          <span className="relative h-[9px] w-[9px] shrink-0">
            <span className="centro-status-dot absolute inset-0 rounded-full bg-brand-emerald" />
          </span>
          <span className="text-xs font-bold text-text-secondary">סנטרו פעיל</span>
        </>
      }
    >
      סנטרו עוקב באופן רציף אחר העסק שלך.
    </Popover>
  );
}
