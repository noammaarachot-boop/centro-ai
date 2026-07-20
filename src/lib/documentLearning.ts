import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  collectionRequestRequirements,
  documentLearnedPatterns,
} from "@/db/schema";
import type { LearnedDocumentPattern } from "@/lib/ai/documentClassifier";
import { isOneTimeWorkflowOrganization } from "@/lib/data/organizations";

/**
 * Milestone 3 ("Document Classification Learning") — the read/write seam
 * for a client's own document-naming history, exactly analogous to
 * src/lib/businessTypes.ts's getLearnedSynonyms/recordLearnedSynonyms for
 * business types. Every write here is triggered by exactly one action
 * (src/app/(app)/collections/actions.ts's assignDocumentRequirement — an
 * employee manually assigning/correcting a document's requirement), so
 * this is the one place that can never be missed.
 */

// Read side — loaded once per inbound document
// (src/app/(app)/collections/conversationActions.ts), checked before the
// generic deterministic heuristic.
export async function getLearnedDocumentPatterns(
  organizationId: string,
  clientId: string
): Promise<LearnedDocumentPattern[]> {
  const db = await getDb();
  const rows = await db
    .select({
      sourceRequirementId: documentLearnedPatterns.sourceRequirementId,
      fileName: documentLearnedPatterns.fileName,
    })
    .from(documentLearnedPatterns)
    .where(
      and(
        eq(documentLearnedPatterns.organizationId, organizationId),
        eq(documentLearnedPatterns.clientId, clientId)
      )
    );
  return rows;
}

// Write side. `collectionRequestRequirementId` is this cycle's snapshot
// row — resolved back to its stable template identity
// (serviceDocumentRequirements.id) before storing, since that's the only
// identity that still means anything in a future cycle's fresh snapshot.
// A requirement with no template source (a one-off, cycle-only addition)
// has nothing stable to learn against and is silently skipped — not an
// error, just nothing to record.
export async function recordLearnedDocumentPattern(
  organizationId: string,
  clientId: string,
  collectionRequestRequirementId: string,
  fileName: string
): Promise<void> {
  // Product Evolution M7 — same boundary as clientDocumentProfile.ts's
  // guards. A one-time-workflow client's document naming is never learned
  // from; the Template it came from is the single source of truth, edited
  // explicitly by the office.
  if (await isOneTimeWorkflowOrganization(organizationId)) return;

  const db = await getDb();
  const [requirement] = await db
    .select({ sourceRequirementId: collectionRequestRequirements.sourceRequirementId })
    .from(collectionRequestRequirements)
    .where(eq(collectionRequestRequirements.id, collectionRequestRequirementId))
    .limit(1);

  if (!requirement?.sourceRequirementId) return;

  await db.insert(documentLearnedPatterns).values({
    organizationId,
    clientId,
    sourceRequirementId: requirement.sourceRequirementId,
    fileName,
  });
}
