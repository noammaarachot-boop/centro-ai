import { clsx } from "clsx";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";

const STATUS_META: Record<
  CollectionRequestStatus,
  { label: string; className: string }
> = {
  draft: { label: "טיוטה", className: "bg-surface-muted text-text-secondary" },
  active: { label: "פעיל", className: "bg-brand-blue/10 text-brand-blue" },
  waiting_for_client: {
    label: "ממתין ללקוח",
    className: "bg-warning/10 text-warning",
  },
  processing: {
    label: "בעיבוד",
    className: "bg-brand-purple/10 text-brand-purple",
  },
  completed: {
    label: "הושלם",
    className: "bg-brand-emerald/10 text-brand-emerald",
  },
  escalated: { label: "הוסלם", className: "bg-danger/10 text-danger" },
  cancelled: { label: "בוטל", className: "bg-surface-muted text-text-muted" },
};

export function StatusBadge({ status }: { status: CollectionRequestStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-medium",
        meta.className
      )}
    >
      {meta.label}
    </span>
  );
}
