"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// "Live" for the activity feed means always-current on load plus a
// lightweight client-side polling refresh — not a push-based WebSocket/
// SSE stream, which this app has no infrastructure for anywhere. Calling
// router.refresh() re-runs the server component tree (a fresh RSC fetch),
// matching this app's server-data convention instead of introducing a
// client-side data-fetching layer just for this one widget.
export function OwnerAutoRefresh({ intervalMs = 45_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  return null;
}
