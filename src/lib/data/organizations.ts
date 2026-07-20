import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";

export async function getOrganization(organizationId: string) {
  const db = await getDb();
  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return organization ?? null;
}

// Product Evolution M7 — the one predicate every document-profile-learning
// write path (src/lib/clientDocumentProfile.ts,
// src/lib/documentLearning.ts) checks before writing anything. Centro
// learns only which documents to collect (Architecture Ch.8), and only for
// the recurring workflow — Workflow B manages its document lists entirely
// through explicit, user-edited Templates, never through observed
// recurrence. Checked inside each write function itself, not only at its
// call sites, so this boundary holds even if a future caller forgets to
// check first.
export async function isOneTimeWorkflowOrganization(organizationId: string): Promise<boolean> {
  const organization = await getOrganization(organizationId);
  return organization?.workflowType === "one_time";
}
