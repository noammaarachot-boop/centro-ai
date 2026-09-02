import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import { Badge } from "@/components/app/Badge";
import { resolveDisplayStatus } from "@/lib/requestDisplayStatus";

/**
 * The single status chip shown for a request, everywhere.
 *
 * The label is not read off the lifecycle column any more. The database
 * keeps "where the request is" and "does a human need to act" as separate
 * facts — correctly — but a reader wants one answer, and a card reading
 * "פעיל" in green while carrying "דורש טיפול" inside it looked like a
 * contradiction. resolveDisplayStatus combines them in one place so no two
 * screens can ever label the same request differently.
 */
export function StatusBadge({
  status,
  hasOpenAttention = false,
}: {
  status: CollectionRequestStatus;
  /** True when this request still has an unhandled attention item. */
  hasOpenAttention?: boolean;
}) {
  const display = resolveDisplayStatus({ status, hasOpenAttention });

  // "בתהליך" keeps the live-signal treatment the dashboard's own
  // CentroStatusIndicator uses — the breathing emerald dot
  // (.centro-status-dot, which honours prefers-reduced-motion) — since it is
  // the one state meaning "Centro is working on this right now". Every other
  // state keeps the plain Badge.
  if (display.key === "in_progress") {
    return (
      <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border py-[5px] ps-[9px] pe-[11px]">
        <span className="relative h-[7px] w-[7px] shrink-0">
          <span className="centro-status-dot absolute inset-0 rounded-full bg-brand-emerald" />
        </span>
        <span className="text-xs font-bold text-text-secondary">{display.label}</span>
      </span>
    );
  }

  return (
    <Badge tone={display.tone} dot>
      {display.label}
    </Badge>
  );
}
