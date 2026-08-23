import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import { Badge, type BadgeTone } from "@/components/app/Badge";

const STATUS_META: Record<CollectionRequestStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "טיוטה", tone: "neutral" },
  active: { label: "פעיל", tone: "blue" },
  waiting_for_client: { label: "ממתין ללקוח", tone: "warning" },
  processing: { label: "בעיבוד", tone: "purple" },
  completed: { label: "הושלם", tone: "success" },
  escalated: { label: "הוסלם", tone: "danger" },
  cancelled: { label: "בוטל", tone: "neutral" },
};

export function StatusBadge({ status }: { status: CollectionRequestStatus }) {
  const meta = STATUS_META[status];

  // "active" is the one status that means "Centro is working on this right
  // now", so it reuses the same live-signal treatment the dashboard's
  // CentroStatusIndicator already uses — the breathing emerald dot
  // (.centro-status-dot, globals.css, which also honours
  // prefers-reduced-motion) — instead of a static blue chip. Same pattern,
  // same class, same colour token; nothing new was invented for it.
  //
  // Every other status keeps the existing Badge exactly as before.
  if (status === "active") {
    return (
      <span className="inline-flex shrink-0 items-center gap-2 rounded-full border border-border py-[5px] ps-[9px] pe-[11px]">
        <span className="relative h-[7px] w-[7px] shrink-0">
          <span className="centro-status-dot absolute inset-0 rounded-full bg-brand-emerald" />
        </span>
        <span className="text-xs font-bold text-text-secondary">{meta.label}</span>
      </span>
    );
  }

  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}
