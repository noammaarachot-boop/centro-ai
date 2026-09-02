import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";
import type { BadgeTone } from "@/components/app/Badge";

/**
 * The ONE status a person is shown for a request.
 *
 * The database deliberately keeps two separate ideas — where a request is in
 * its life, and whether a human is currently needed — and that separation
 * must stay: merging them back into one column is the bug we just removed.
 * But a reader does not want two answers. A card that said "פעיל" in green
 * while carrying "דורש טיפול" inside it looked like a contradiction, because
 * "פעיל" reads as "all is well".
 *
 * So the split stays in the data and is resolved here, once, for display.
 * Every surface calls this, so the same request can never be labelled two
 * different things on two different screens.
 *
 * Order matters, and it is the order of what a reader needs to know first:
 * a finished request is finished whatever else is true; an open attention
 * outranks any in-flight state, because it is the thing requiring action;
 * only then does the lifecycle speak for itself.
 */
export type DisplayStatusKey =
  | "completed"
  | "cancelled"
  | "needs_attention"
  | "waiting_for_client"
  | "in_progress"
  | "draft";

export interface DisplayStatus {
  key: DisplayStatusKey;
  label: string;
  tone: BadgeTone;
}

export function resolveDisplayStatus(input: {
  status: CollectionRequestStatus;
  /** Whether this request has at least one attention item still open. */
  hasOpenAttention?: boolean;
}): DisplayStatus {
  const { status, hasOpenAttention = false } = input;

  if (status === "completed") return { key: "completed", label: "הושלם", tone: "success" };
  if (status === "cancelled") return { key: "cancelled", label: "בוטל", tone: "neutral" };

  // Never sent yet — there is nothing in flight to need attention about, and
  // saying "דורש טיפול" on a draft would point at the wrong thing.
  if (status === "draft") return { key: "draft", label: "טיוטה", tone: "neutral" };

  // The one thing asking for a human right now.
  //
  // `hasOpenAttention` must come from getItemsNeedingReview — the single
  // derivation every surface shares. Passing a locally-computed opinion here
  // is what produced the original bug, and no amount of resolving in one
  // place can fix two different inputs.
  //
  // "escalated" is still checked because it remains a legal value of the
  // status column for rows written before escalation became its own field.
  // Nothing writes it any more; the reconciliation clears the ones that
  // exist. Until then a legacy row must not read as merely "בתהליך".
  if (hasOpenAttention || status === "escalated") {
    return { key: "needs_attention", label: "דורש טיפול", tone: "danger" };
  }

  if (status === "waiting_for_client") {
    return { key: "waiting_for_client", label: "ממתין ללקוח", tone: "warning" };
  }

  // "פעיל" was ambiguous here: in a document-collection context a reader
  // takes it to mean "fine", when it only ever meant "running".
  return { key: "in_progress", label: "בתהליך", tone: "blue" };
}
