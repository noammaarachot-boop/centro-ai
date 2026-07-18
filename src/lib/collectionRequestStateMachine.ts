import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  collectionRequestRequirements,
  documents,
  serviceDocumentRequirements,
} from "@/db/schema";

export type CollectionRequestStatus =
  | "draft"
  | "active"
  | "waiting_for_client"
  | "processing"
  | "completed"
  | "escalated"
  | "cancelled";

// EPS Ch.6: Draft → Active → Waiting for Client → Processing → Completed /
// Escalated / Cancelled. `completed` only transitions back to `active` via
// the reopen action (Ch.16 FR-16.8 / glossary "Reopened Collection"), never
// forward again — everything else follows the diagram directly. FR-6.2:
// every transition must be validated before execution.
const ALLOWED_TRANSITIONS: Record<
  CollectionRequestStatus,
  CollectionRequestStatus[]
> = {
  draft: ["active", "cancelled"],
  active: ["waiting_for_client", "processing", "escalated", "cancelled"],
  waiting_for_client: ["active", "processing", "escalated", "cancelled"],
  processing: ["waiting_for_client", "completed", "escalated", "cancelled"],
  escalated: ["active", "waiting_for_client", "processing", "cancelled"],
  completed: ["active"],
  cancelled: [],
};

export function canTransition(
  from: CollectionRequestStatus,
  to: CollectionRequestStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function nextStatusOptions(
  from: CollectionRequestStatus
): CollectionRequestStatus[] {
  return ALLOWED_TRANSITIONS[from] ?? [];
}

// BR-11.2: the request remains open until all required documents are
// received. BR-6.1: only validated (approved) documents satisfy a
// requirement. BR-6.2: documents still "processing" block completion.
export async function checkCompletionGate(
  collectionRequestId: string
): Promise<string | null> {
  const db = await getDb();

  const requirements = await db
    .select({ id: collectionRequestRequirements.id })
    .from(collectionRequestRequirements)
    .where(
      eq(collectionRequestRequirements.collectionRequestId, collectionRequestId)
    );

  const requestDocuments = await db
    .select({
      requirementId: documents.requirementId,
      status: documents.status,
    })
    .from(documents)
    .where(eq(documents.collectionRequestId, collectionRequestId));

  if (requestDocuments.some((doc) => doc.status === "processing")) {
    return "לא ניתן להשלים בקשה כאשר יש מסמכים בעיבוד.";
  }

  const approvedRequirementIds = new Set(
    requestDocuments
      .filter((doc) => doc.status === "approved" && doc.requirementId)
      .map((doc) => doc.requirementId)
  );

  const unsatisfied = requirements.filter(
    (req) => !approvedRequirementIds.has(req.id)
  );
  if (unsatisfied.length > 0) {
    return `יש ${unsatisfied.length} דרישות מסמכים שטרם אושרו.`;
  }

  return null;
}

export async function snapshotServiceRequirements(
  collectionRequestId: string,
  serviceId: string
) {
  const db = await getDb();
  const templates = await db
    .select()
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, serviceId));

  if (templates.length === 0) return;

  await db.insert(collectionRequestRequirements).values(
    templates.map((template) => ({
      collectionRequestId,
      sourceRequirementId: template.id,
      name: template.name,
      description: template.description,
    }))
  );
}
