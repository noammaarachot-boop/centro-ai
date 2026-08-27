"use client";

import { useEffect, useRef } from "react";

/**
 * The conversation's one scroll region.
 *
 * This area has now been wrong in two opposite directions, and the fix has
 * to hold both ends down at once:
 *
 *  - It used to be TWO scrollers — history inside a `max-h-64 overflow-y-auto`
 *    box, and the three newest messages in a separate list outside it. The
 *    inner box scrolled while those three sat still in page flow, so the
 *    newest messages looked pinned.
 *  - Removing the box fixed that but put the entire history into page flow,
 *    so a long thread stretched the request page to an absurd height and
 *    reaching the latest message meant scrolling the whole document.
 *
 * So: one bounded region, every message inside it, nothing sticky, and the
 * newest message already in view when the page opens.
 *
 * A client component only because the initial scroll position is a DOM
 * property with no server-rendered equivalent. The messages themselves stay
 * server-rendered and are passed straight through as children.
 */
export function ConversationScroll({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Jump, never smooth-scroll: this is the starting position, not a
    // movement the reader asked for, and animating it on load reads as the
    // page still settling.
    el.scrollTop = el.scrollHeight;
  }, []);

  return (
    <div
      ref={ref}
      // overscroll-contain stops a flick at the end of the thread from
      // carrying on into the page behind it.
      className="mb-4 max-h-[26rem] overflow-y-auto overscroll-contain rounded-xl border border-border bg-background/40 p-3 sm:max-h-[30rem]"
    >
      {children}
    </div>
  );
}
