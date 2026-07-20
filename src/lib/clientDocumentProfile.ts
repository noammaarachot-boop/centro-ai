import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  clientDocumentRequirements,
  clients,
  collectionRequestRequirements,
  collectionRequests,
  documents,
  serviceDocumentRequirements,
} from "@/db/schema";
import { createPendingConfirmation, type PendingConfirmationKind } from "@/lib/pendingConfirmations";

/**
 * Milestone 6 ("Adaptive Document Collection") — the one thing Architecture
 * Ch.8 permits Centro to learn: which documents to request from a specific
 * client. Every function here follows Ch.3's Observe -> Suggest -> Confirm
 * -> Learn lifecycle explicitly:
 *
 *   - recordAdHocDocumentObservation (Observe, addition side): an employee
 *     names an unmatched document something not currently requested. Only
 *     on its *second* occurrence for this client does this Suggest a
 *     standing addition — never from a single event.
 *   - detectMissingRequirements (Observe, removal side): called when a
 *     Collection Request completes. Only once a client is past Learning
 *     Mode (Milestone 2) and a requirement has gone unsatisfied for two
 *     consecutive completed cycles does this Suggest dropping it — never
 *     from one quiet month.
 *   - Both Suggest paths hand off to src/lib/pendingConfirmations.ts
 *     (Milestone 5) for the actual Confirm step over WhatsApp.
 *   - applyDocumentProfileConfirmation (Learn): the client's reply, and
 *     only the client's reply, ever changes clientDocumentRequirements'
 *     status.
 *   - resolveEffectiveRequirementNames / snapshot integration: what a
 *     confirmed change actually *does* — included or excluded the next
 *     time this client's requirements are snapshotted
 *     (collectionRequestStateMachine.ts's snapshotServiceRequirements).
 */

const OCCURRENCE_THRESHOLD_FOR_SUGGESTION = 2;

export interface EffectiveRequirement {
  sourceRequirementId: string | null;
  name: string;
  description: string | null;
}

// What snapshotServiceRequirements actually copies into a new Collection
// Request: the service's template, minus this client's confirmed
// removals, plus this client's confirmed additions. A service's template
// itself is never touched — this is purely a per-client view over it.
export async function resolveEffectiveRequirementNames(
  organizationId: string,
  clientId: string,
  serviceId: string
): Promise<EffectiveRequirement[]> {
  const db = await getDb();

  const templates = await db
    .select({
      id: serviceDocumentRequirements.id,
      name: serviceDocumentRequirements.name,
      description: serviceDocumentRequirements.description,
    })
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, serviceId));

  const overrides = await db
    .select()
    .from(clientDocumentRequirements)
    .where(
      and(
        eq(clientDocumentRequirements.organizationId, organizationId),
        eq(clientDocumentRequirements.clientId, clientId),
        eq(clientDocumentRequirements.status, "confirmed")
      )
    );

  const removedTemplateIds = new Set(
    overrides.filter((o) => o.action === "remove" && o.sourceRequirementId).map((o) => o.sourceRequirementId)
  );
  const confirmedAdditions = overrides.filter((o) => o.action === "add");

  const effective: EffectiveRequirement[] = templates
    .filter((t) => !removedTemplateIds.has(t.id))
    .map((t) => ({ sourceRequirementId: t.id, name: t.name, description: t.description }));

  for (const addition of confirmedAdditions) {
    effective.push({ sourceRequirementId: null, name: addition.name, description: null });
  }

  return effective;
}

function normalizeName(name: string): string {
  return name.trim();
}

// Observe (addition side). Called whenever an employee assigns an
// unmatched document to a name that isn't one of the current cycle's
// offered requirements — i.e. a genuinely new document type for this
// client, not just a misclassification of an existing one (that path
// stays Milestone 3's learned-pattern matching). Upserts an occurrence
// counter; only Suggests once it reaches 2.
export async function recordAdHocDocumentObservation(
  organizationId: string,
  clientId: string,
  collectionRequestId: string,
  rawName: string,
  fileName: string
): Promise<void> {
  const name = normalizeName(rawName);
  if (!name) return;

  const db = await getDb();

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
    .limit(1);
  if (!client) return;

  const [row] = await db
    .insert(clientDocumentRequirements)
    .values({ organizationId, clientId, action: "add", name, occurrenceCount: 1 })
    .onConflictDoUpdate({
      target: [
        clientDocumentRequirements.clientId,
        clientDocumentRequirements.name,
        clientDocumentRequirements.action,
      ],
      set: {
        occurrenceCount: sql`${clientDocumentRequirements.occurrenceCount} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning();

  // Learning Mode (Milestone 2) doesn't gate the addition side directly —
  // reaching a second occurrence already requires at least two separate
  // imports/uploads for this client, which in practice never happens
  // inside a single first cycle. Still checked explicitly for clarity and
  // to match the architecture document's stated intent exactly, not by
  // incidental timing.
  if (
    client.learningMode ||
    row.status !== "pending" ||
    row.pendingConfirmationId ||
    row.occurrenceCount < OCCURRENCE_THRESHOLD_FOR_SUGGESTION
  ) {
    return;
  }

  const question = `שלום! שמנו לב שגם החודש שלחתם מסמך "${fileName}" מסוג "${name}". האם נכון לבקש מסמך כזה גם באיסופים הבאים באופן קבוע? השיבו 'כן' או 'לא'.`;

  const confirmation = await createPendingConfirmation({
    organizationId,
    clientId,
    collectionRequestId,
    kind: "document_profile_addition",
    payload: { clientDocumentRequirementId: row.id, name },
    question,
  });

  await db
    .update(clientDocumentRequirements)
    .set({ pendingConfirmationId: confirmation.id, updatedAt: new Date() })
    .where(eq(clientDocumentRequirements.id, row.id));
}

// Observe (removal side). Called when a Collection Request completes
// (collectionRequestStateMachine.ts). Only considers a client past
// Learning Mode, and only a requirement unsatisfied across the last two
// completed cycles for this service — never a single quiet month.
export async function detectMissingRequirements(
  organizationId: string,
  clientId: string,
  serviceId: string
): Promise<void> {
  const db = await getDb();

  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)))
    .limit(1);
  if (!client || client.learningMode) return;

  const recentCycles = await db
    .select({ id: collectionRequests.id })
    .from(collectionRequests)
    .where(
      and(
        eq(collectionRequests.organizationId, organizationId),
        eq(collectionRequests.clientId, clientId),
        eq(collectionRequests.serviceId, serviceId),
        eq(collectionRequests.status, "completed")
      )
    )
    .orderBy(desc(collectionRequests.completedAt))
    .limit(2);

  if (recentCycles.length < 2) return; // not enough history yet
  const cycleIds = recentCycles.map((c) => c.id);

  const effective = await resolveEffectiveRequirementNames(organizationId, clientId, serviceId);
  const templateRequirements = effective.filter(
    (r): r is EffectiveRequirement & { sourceRequirementId: string } => r.sourceRequirementId !== null
  );
  if (templateRequirements.length === 0) return;

  const cycleRequirementRows = await db
    .select({
      id: collectionRequestRequirements.id,
      collectionRequestId: collectionRequestRequirements.collectionRequestId,
      sourceRequirementId: collectionRequestRequirements.sourceRequirementId,
    })
    .from(collectionRequestRequirements)
    .where(inArray(collectionRequestRequirements.collectionRequestId, cycleIds));

  const approvedDocs = await db
    .select({ requirementId: documents.requirementId })
    .from(documents)
    .where(and(inArray(documents.collectionRequestId, cycleIds), eq(documents.status, "approved")));
  const approvedRequirementRowIds = new Set(approvedDocs.map((d) => d.requirementId).filter(Boolean));

  for (const requirement of templateRequirements) {
    // "Missing" in a given cycle means either: present in that cycle's
    // snapshot but never approved, OR absent from the snapshot entirely
    // — an employee can waive a specific requirement for one cycle
    // (waiveRequirement, e.g. "no vehicle expenses this month"), which
    // removes its collectionRequestRequirements row outright rather than
    // leaving an eternally-unsatisfied one blocking completion (BR-11.2:
    // completion requires every *offered* requirement to be satisfied —
    // a cycle can never reach `completed` with an unsatisfied one still
    // present, so "waived" is the only way a recurring absence can ever
    // actually show up in completed-cycle history).
    const missingInEveryCycle = cycleIds.every((cycleId) => {
      const row = cycleRequirementRows.find(
        (r) => r.collectionRequestId === cycleId && r.sourceRequirementId === requirement.sourceRequirementId
      );
      return !row || !approvedRequirementRowIds.has(row.id);
    });
    if (!missingInEveryCycle) continue;

    const [existing] = await db
      .select({ id: clientDocumentRequirements.id })
      .from(clientDocumentRequirements)
      .where(
        and(
          eq(clientDocumentRequirements.organizationId, organizationId),
          eq(clientDocumentRequirements.clientId, clientId),
          eq(clientDocumentRequirements.name, requirement.name),
          eq(clientDocumentRequirements.action, "remove")
        )
      )
      .limit(1);
    if (existing) continue; // already asked (or already resolved) about this one

    const [row] = await db
      .insert(clientDocumentRequirements)
      .values({
        organizationId,
        clientId,
        action: "remove",
        name: requirement.name,
        sourceRequirementId: requirement.sourceRequirementId,
        occurrenceCount: 2,
      })
      .returning();

    const question = `שלום! בדרך כלל אנחנו אוספים "${requirement.name}" מדי חודש, אך לא קיבלנו לאחרונה. האם להמשיך לבקש זאת באיסופים הבאים? השיבו 'כן' או 'לא'.`;

    const confirmation = await createPendingConfirmation({
      organizationId,
      clientId,
      collectionRequestId: cycleIds[0],
      kind: "document_profile_removal",
      payload: { clientDocumentRequirementId: row.id, name: requirement.name },
      question,
    });

    await db
      .update(clientDocumentRequirements)
      .set({ pendingConfirmationId: confirmation.id, updatedAt: new Date() })
      .where(eq(clientDocumentRequirements.id, row.id));
  }
}

// Learn — the only function that ever moves a clientDocumentRequirements
// row out of `pending`, and only ever from a resolved pendingConfirmation.
// The removal question is phrased as "should we *continue*", so its
// yes/no meaning is inverted relative to the addition question ("should
// we *add* this") — confirming a removal question means "keep it as is",
// i.e. the removal itself is declined; declining it means "no, stop
// asking for it", i.e. the removal is confirmed.
export async function applyDocumentProfileConfirmation(resolved: {
  id: string;
  kind: string;
  status: string;
}): Promise<void> {
  if (resolved.kind !== ("document_profile_addition" satisfies PendingConfirmationKind) &&
    resolved.kind !== ("document_profile_removal" satisfies PendingConfirmationKind)) {
    return;
  }

  const db = await getDb();
  const [row] = await db
    .select({ id: clientDocumentRequirements.id, action: clientDocumentRequirements.action })
    .from(clientDocumentRequirements)
    .where(eq(clientDocumentRequirements.pendingConfirmationId, resolved.id))
    .limit(1);
  if (!row) return;

  const clientConfirmedTheQuestion = resolved.status === "confirmed";
  const newStatus =
    row.action === "add"
      ? clientConfirmedTheQuestion
        ? "confirmed"
        : "declined"
      : clientConfirmedTheQuestion
        ? "declined" // "yes, continue requesting it" -> the removal is declined
        : "confirmed"; // "no, stop" -> the removal is confirmed

  await db
    .update(clientDocumentRequirements)
    .set({ status: newStatus, updatedAt: new Date() })
    .where(eq(clientDocumentRequirements.id, row.id));
}

export async function listClientDocumentProfileChanges(organizationId: string, clientId: string) {
  const db = await getDb();
  return db
    .select()
    .from(clientDocumentRequirements)
    .where(
      and(
        eq(clientDocumentRequirements.organizationId, organizationId),
        eq(clientDocumentRequirements.clientId, clientId)
      )
    )
    .orderBy(desc(clientDocumentRequirements.updatedAt));
}
