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
  return (
    <Badge tone={meta.tone} dot>
      {meta.label}
    </Badge>
  );
}
