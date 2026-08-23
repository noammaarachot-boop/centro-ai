"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { resolveSectionOpen, serializeSectionState } from "@/lib/owner/sectionState";

// One consistent way to fold an area away across the owner console.
//
// Built on <details>/<summary> so it stays keyboard- and screen-reader
// accessible for free. When a `storageKey` is supplied the open/closed
// state becomes the USER'S, and survives both a re-render caused by a
// server action inside the section and a full page refresh.
//
// Why that matters here: every action in these sections is a server
// action followed by a redirect, so the page re-renders from scratch.
// Without persistence, an action taken inside an open section would
// collapse the section the moment it completed.
//
// `defaultOpen` is deliberately only a FIRST-VISIT fallback: once the user
// has expressed a preference for this section it always wins, so a section
// the user closed never re-opens itself.

// useLayoutEffect applies the stored state before the browser paints, so
// there is no visible flash of the wrong state. On the server it must fall
// back to useEffect, which React never runs there.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export function CollapsibleSection({
  title,
  subtitle,
  badge,
  defaultOpen = false,
  storageKey,
  children,
}: {
  title: string;
  subtitle?: string;
  /** Optional status shown on the closed row, so the fold still tells you something. */
  badge?: ReactNode;
  /** Used ONLY when the user has no stored preference for this section yet. */
  defaultOpen?: boolean;
  /**
   * Stable, per-section identity (scope it per organization). Omit to keep
   * the previous stateless behavior.
   */
  storageKey?: string;
  children: ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  // Tracked in React purely to drive the chevron; the <details> element
  // itself remains the source of truth for what is rendered.
  const [open, setOpen] = useState(defaultOpen);

  useIsomorphicLayoutEffect(() => {
    if (!storageKey || !detailsRef.current) return;
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(storageKey);
    } catch {
      // Private mode / storage disabled — fall through to defaultOpen.
      return;
    }
    const shouldBeOpen = resolveSectionOpen(stored, defaultOpen);
    detailsRef.current.open = shouldBeOpen;
    setOpen(shouldBeOpen);
    // defaultOpen is intentionally not a dependency: it is only ever the
    // first-visit fallback, and re-running this when it changes would let
    // a server-derived value (e.g. "a template was just rejected") reopen
    // a section the user had deliberately closed.
  }, [storageKey]);

  function handleToggle() {
    const isOpen = detailsRef.current?.open ?? false;
    setOpen(isOpen);
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, serializeSectionState(isOpen));
    } catch {
      // Persisting is best-effort; the section still works without it.
    }
  }

  return (
    <details
      ref={detailsRef}
      open={defaultOpen}
      onToggle={handleToggle}
      className="group rounded-2xl border border-border bg-surface-muted/40 transition-colors open:bg-transparent"
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5">
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-semibold text-text-primary">{title}</span>
          {subtitle && <p className="mt-0.5 text-xs text-text-muted">{subtitle}</p>}
        </div>
        {badge && <span className="shrink-0">{badge}</span>}
      </summary>
      <div className="border-t border-border px-5 py-4">{children}</div>
    </details>
  );
}
