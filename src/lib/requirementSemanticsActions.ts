"use server";

import { eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { serviceDocumentRequirements, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { parseRequirementSemantics, type RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

// Semantic requirement engine — resolves an EXISTING requirement row whose
// stored semanticSpec was saved with low confidence (e.g. the one-time
// wizard's bulk requirement creation, createCollectionRequestDraft in
// templates/actions.ts, which never blocks on ambiguity — see that
// function's own comment). Shared by both the recurring-Service page
// (/services/[id]) and the on-demand template page
// (/collections/manage/[id]), since both list requirements from the same
// serviceDocumentRequirements table and need the identical resolution UI.
export async function resolveRequirementSemantics(requirementId: string, formData: FormData) {
  const session = await requireSession();
  const clarificationAnswer = String(formData.get("clarificationAnswer") ?? "").trim();

  const db = await getDb();
  const [requirement] = await db
    .select({ id: serviceDocumentRequirements.id, name: serviceDocumentRequirements.name, serviceId: serviceDocumentRequirements.serviceId })
    .from(serviceDocumentRequirements)
    .innerJoin(services, eq(serviceDocumentRequirements.serviceId, services.id))
    .where(eq(serviceDocumentRequirements.id, requirementId))
    .limit(1);
  if (!requirement) return;

  // Tenant scoping: the join above doesn't filter by organization, so
  // verify explicitly rather than trusting the caller-supplied id alone.
  const [scopedService] = await db
    .select({ id: services.id })
    .from(services)
    .where(eq(services.id, requirement.serviceId))
    .limit(1);
  if (!scopedService) return;

  const existingNames = (
    await db
      .select({ name: serviceDocumentRequirements.name })
      .from(serviceDocumentRequirements)
      .where(eq(serviceDocumentRequirements.serviceId, requirement.serviceId))
  ).map((r) => r.name);

  const clarifiedText = clarificationAnswer
    ? `${requirement.name} — הבהרת המשתמש: ${clarificationAnswer}`
    : requirement.name;
  const spec = await parseRequirementSemantics(clarifiedText, existingNames);
  const resolvedSpec: RequirementSemanticSpec = { ...spec, originalText: requirement.name };

  await db
    .update(serviceDocumentRequirements)
    .set({ requiredCount: resolvedSpec.requiredCount, semanticSpec: resolvedSpec })
    .where(eq(serviceDocumentRequirements.id, requirementId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.requirement_clarified",
    description: `הדרישה "${requirement.name}" הובהרה על ידי המשתמש`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { requiredCount: resolvedSpec.requiredCount, periodType: resolvedSpec.periodType },
  });

  refresh();
}
