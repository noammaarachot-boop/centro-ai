"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { clsx } from "clsx";

/**
 * The app's one floating-panel primitive.
 *
 * Built on the native Popover API, for the same reason ConfirmDialog is: the
 * browser promotes a `popover` element to the TOP LAYER, so it renders above
 * every card on the page and cannot be clipped by an ancestor's
 * overflow — regardless of z-index or stacking contexts. It also gives us
 * Escape-to-close and light-dismiss (click outside) with no JS.
 *
 * That last part is the whole point. The pattern this replaces was a plain
 * `absolute z-20` div inside a `relative` parent, which meant:
 *   • any ancestor with overflow-hidden cut it off (Table does exactly this,
 *     so every help tip inside a table was clipped);
 *   • any sibling card that formed a stacking context covered it;
 *   • it always opened down-and-start, so near a viewport edge it opened
 *     off-screen.
 *
 * The top layer fixes the first two structurally. This component adds the
 * third: because a top-layer element is positioned against the viewport
 * rather than its anchor, placement has to be measured, and measuring is
 * what lets it flip and clamp instead of overflowing.
 */

const VIEWPORT_MARGIN = 8;
/** Below this width a panel anchored to a small trigger has nowhere useful
 *  to go, so it becomes a near-full-width sheet instead. */
const NARROW_VIEWPORT = 420;

type Placement = { top: number; left: number; width?: number; side: "top" | "bottom" };

export function Popover({
  trigger,
  triggerClassName,
  triggerLabel,
  children,
  panelClassName,
  width = 256,
  role = "dialog",
}: {
  /** Content of the trigger button (this component renders the button). */
  trigger: ReactNode;
  triggerClassName?: string;
  /** Accessible name, when `trigger` is icon-only. */
  triggerLabel?: string;
  children: ReactNode;
  panelClassName?: string;
  width?: number;
  role?: "dialog" | "tooltip";
}) {
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [open, setOpen] = useState(false);

  const reposition = useCallback(() => {
    const anchor = triggerRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const rect = anchor.getBoundingClientRect();
    const { innerWidth: vw, innerHeight: vh } = window;
    const narrow = vw < NARROW_VIEWPORT;

    const panelWidth = narrow ? Math.min(vw - VIEWPORT_MARGIN * 2, 360) : width;
    const panelHeight = panel.offsetHeight || 0;

    // Prefer below; flip above when there isn't room and there is more above.
    const roomBelow = vh - rect.bottom - VIEWPORT_MARGIN;
    const roomAbove = rect.top - VIEWPORT_MARGIN;
    const side: "top" | "bottom" =
      roomBelow < panelHeight && roomAbove > roomBelow ? "top" : "bottom";
    const top = side === "bottom" ? rect.bottom + 8 : Math.max(VIEWPORT_MARGIN, rect.top - panelHeight - 8);

    // Align to the trigger, then clamp into the viewport. Clamping is what
    // makes this correct in both LTR and RTL without branching on direction:
    // whichever edge would spill, the panel is pushed back inside.
    let left = narrow
      ? (vw - panelWidth) / 2
      : rect.left + rect.width / 2 - panelWidth / 2;
    // Clamp order matters. Written as min(max(...)) the outer min wins when
    // the panel is wide relative to the viewport — the upper bound
    // (vw - panelWidth - margin) falls below the lower bound (margin), and
    // the result goes negative, putting the panel off the start edge
    // (measured at x=-10 on a 320px screen). Clamping the low edge LAST
    // guarantees the margin always survives.
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - panelWidth - VIEWPORT_MARGIN));

    setPlacement({ top, left, width: panelWidth, side });
  }, [width]);

  // The browser owns open/close (via popovertarget), so we listen rather
  // than drive it — this keeps Escape and light-dismiss working untouched.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const onToggle = (event: Event) => {
      const isOpen = (event as ToggleEvent).newState === "open";
      setOpen(isOpen);
      if (isOpen) {
        // Measure after the browser has laid the panel out in the top layer.
        requestAnimationFrame(reposition);
      }
    };
    panel.addEventListener("toggle", onToggle);
    return () => panel.removeEventListener("toggle", onToggle);
  }, [reposition]);

  // While open, keep it anchored — scrolling or resizing otherwise leaves
  // the panel behind at stale coordinates.
  useEffect(() => {
    if (!open) return;
    const handler = () => reposition();
    window.addEventListener("scroll", handler, true);
    window.addEventListener("resize", handler);
    return () => {
      window.removeEventListener("scroll", handler, true);
      window.removeEventListener("resize", handler);
    };
  }, [open, reposition]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={panelId}
        aria-label={triggerLabel}
        // Stable hook for the responsive smoke test to find and open every
        // popover in the app. Inert attribute — no behaviour attached.
        data-popover-trigger=""
        // Only focus behaviour is fixed here; every visual choice belongs to
        // the caller, so a trigger can be a text link, an icon, or a pill
        // without fighting a default it has to override.
        className={clsx(
          "focus-visible:outline-2 focus-visible:outline-offset-2",
          triggerClassName
        )}
      >
        {trigger}
      </button>

      <div
        ref={panelRef}
        id={panelId}
        // "auto" is what provides Escape and light-dismiss, and ensures only
        // one popover is open at a time.
        popover="auto"
        role={role}
        className={clsx(
          "centro-glass-strong m-0 rounded-2xl border border-border p-4 text-start shadow-card-lg",
          // Hidden until measured, so it never paints at 0,0 first.
          placement ? "opacity-100" : "opacity-0",
          "transition-opacity duration-150",
          panelClassName
        )}
        style={{
          // `inset` MUST come first. It is a shorthand covering top/left, so
          // listing it after them (as this did) silently reset the computed
          // position back to auto — the browser then fell back to its own
          // popover centring, which is what actually pushed the panel off
          // the start edge. Clearing the UA default before setting real
          // coordinates is the whole point.
          inset: "unset",
          position: "fixed",
          top: placement?.top ?? 0,
          left: placement?.left ?? 0,
          width: placement?.width ?? width,
          maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
          maxHeight: `calc(100dvh - ${VIEWPORT_MARGIN * 2}px)`,
          overflowY: "auto",
          // Without this the p-4 padding is added OUTSIDE the width used to
          // compute placement, so the box is wider than the clamp assumed.
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </>
  );
}
