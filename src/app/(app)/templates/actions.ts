"use server";

import { and, asc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { serviceDocumentRequirements, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { suggestTemplateLibrary } from "@/lib/ai/businessCategorySuggestions";
import { getOrganization } from "@/lib/data/organizations";

// Product Evolution M5 — a Template is a bare `services` row for a
// one-time-workflow organization (see ARCHITECTURE.md); these actions are
// thin, Template-branded wrappers around the exact same DB operations
// src/app/(app)/services/actions.ts already has, differing only in audit
// copy and redirect targets (a Template's "home" is /templates/[id], not
// /services/[id]) — kept as their own file rather than literally calling
// into services/actions.ts so each domain's audit trail reads clearly on
// its own.

export interface TemplateFormState {
  error?: string;
  fieldErrors?: { name?: string };
}

async function getOrgScopedTemplate(organizationId: string, templateId: string) {
  const db = await getDb();
  const [template] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, templateId), eq(services.organizationId, organizationId)))
    .limit(1);
  if (!template) redirect("/templates");
  return template;
}

export async function createTemplate(
  _prevState: TemplateFormState,
  formData: FormData
): Promise<TemplateFormState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) return { fieldErrors: { name: "נא להזין שם תבנית." } };

  const db = await getDb();
  const [template] = await db
    .insert(services)
    .values({ organizationId: session.organizationId, name, description: description || null })
    .returning();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.created",
    description: `התבנית "${template.name}" נוצרה`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/templates/${template.id}`);
}

export async function updateTemplate(
  templateId: string,
  _prevState: TemplateFormState,
  formData: FormData
): Promise<TemplateFormState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) return { fieldErrors: { name: "נא להזין שם תבנית." } };

  const db = await getDb();
  const [template] = await db
    .update(services)
    .set({ name, description: description || null, updatedAt: new Date() })
    .where(and(eq(services.id, templateId), eq(services.organizationId, session.organizationId)))
    .returning();

  if (!template) return { error: "התבנית לא נמצאה." };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.updated",
    description: `פרטי התבנית "${template.name}" עודכנו`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/templates/${template.id}`);
}

export async function deleteTemplate(templateId: string) {
  const session = await requireSession();
  const db = await getDb();

  try {
    const [template] = await db
      .delete(services)
      .where(and(eq(services.id, templateId), eq(services.organizationId, session.organizationId)))
      .returning();

    if (template) {
      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "template.deleted",
        description: `התבנית "${template.name}" נמחקה`,
        actorType: "employee",
        actorUserId: session.userId,
      });
    }
  } catch {
    redirect(`/templates/${templateId}?error=has-history`);
  }

  redirect("/templates");
}

// Duplicates a template's name/description and every one of its document
// requirements (name + position preserved) — a genuinely useful standalone
// action, not just a convenience, since a one-time office often sends
// near-identical requests to slightly different audiences (e.g. "Tenant
// Documents" vs "Tenant Documents — Furnished Unit").
export async function duplicateTemplate(templateId: string) {
  const session = await requireSession();
  const db = await getDb();

  const [original] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, templateId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!original) redirect("/templates");

  const [copy] = await db
    .insert(services)
    .values({
      organizationId: session.organizationId,
      name: `${original.name} (העתק)`,
      description: original.description,
    })
    .returning();

  const originalRequirements = await db
    .select()
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, templateId))
    .orderBy(asc(serviceDocumentRequirements.position), asc(serviceDocumentRequirements.createdAt));

  if (originalRequirements.length > 0) {
    await db.insert(serviceDocumentRequirements).values(
      originalRequirements.map((r, index) => ({
        serviceId: copy.id,
        name: r.name,
        description: r.description,
        position: index,
      }))
    );
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.duplicated",
    description: `התבנית "${original.name}" שוכפלה ל"${copy.name}"`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/templates/${copy.id}`);
}

export async function addTemplateRequirement(templateId: string, formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/templates/${templateId}?error=requirement-name`);
  }

  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  await db.insert(serviceDocumentRequirements).values({ serviceId: templateId, name });

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.requirement_added",
    description: `מסמך "${name}" נוסף לתבנית`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

export async function removeTemplateRequirement(templateId: string, requirementId: string) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  await db
    .delete(serviceDocumentRequirements)
    .where(
      and(
        eq(serviceDocumentRequirements.id, requirementId),
        eq(serviceDocumentRequirements.serviceId, templateId)
      )
    );

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.requirement_removed",
    description: "מסמך הוסר מהתבנית",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

export async function renameTemplateRequirement(
  templateId: string,
  requirementId: string,
  formData: FormData
) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    refresh();
    return;
  }

  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  await db
    .update(serviceDocumentRequirements)
    .set({ name })
    .where(
      and(
        eq(serviceDocumentRequirements.id, requirementId),
        eq(serviceDocumentRequirements.serviceId, templateId)
      )
    );

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.requirement_renamed",
    description: `שם מסמך בתבנית שונה ל-"${name}"`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// Reordering — simple move-up/move-down rather than a drag-and-drop
// library, matching "don't add complexity beyond what's needed." Any
// requirement with a still-null position (never reordered) is treated as
// sitting after every explicitly-positioned one, matching how they
// already render (see listServiceRequirements's ordering) — so the first
// move on a never-reordered template assigns real 0..N positions to the
// whole list in its current (creation-order) sequence, then swaps the
// two requested neighbors.
async function ensureExplicitPositions(templateId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: serviceDocumentRequirements.id, position: serviceDocumentRequirements.position })
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, templateId))
    .orderBy(asc(serviceDocumentRequirements.position), asc(serviceDocumentRequirements.createdAt));

  if (rows.every((r) => r.position !== null)) return rows.map((r) => r.id);

  for (let i = 0; i < rows.length; i += 1) {
    await db
      .update(serviceDocumentRequirements)
      .set({ position: i })
      .where(eq(serviceDocumentRequirements.id, rows[i].id));
  }
  return rows.map((r) => r.id);
}

async function moveRequirement(templateId: string, requirementId: string, direction: -1 | 1) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const orderedIds = await ensureExplicitPositions(templateId);
  const index = orderedIds.indexOf(requirementId);
  const swapWithIndex = index + direction;
  if (index === -1 || swapWithIndex < 0 || swapWithIndex >= orderedIds.length) {
    refresh();
    return;
  }

  const db = await getDb();
  await db
    .update(serviceDocumentRequirements)
    .set({ position: swapWithIndex })
    .where(eq(serviceDocumentRequirements.id, requirementId));
  await db
    .update(serviceDocumentRequirements)
    .set({ position: index })
    .where(eq(serviceDocumentRequirements.id, orderedIds[swapWithIndex]));

  refresh();
}

export async function moveRequirementUp(templateId: string, requirementId: string) {
  await moveRequirement(templateId, requirementId, -1);
}

export async function moveRequirementDown(templateId: string, requirementId: string) {
  await moveRequirement(templateId, requirementId, 1);
}

// The Template Library — one-click starter templates from
// suggestTemplateLibrary, keyed by canonicalKey (re-derived server-side
// from the organization's own declared category, never trusted from the
// client) so the actual document list can't be tampered with via the form.
export async function createTemplateFromLibrary(formData: FormData) {
  const session = await requireSession();
  const canonicalKey = String(formData.get("canonicalKey") ?? "");

  const organization = await getOrganization(session.organizationId);
  if (!organization) redirect("/templates");

  const library = await suggestTemplateLibrary(
    organization.businessCategory,
    organization.businessCategoryCustomLabel
  );
  const chosen = library.find((entry) => entry.canonicalKey === canonicalKey);
  if (!chosen) redirect("/templates");

  const db = await getDb();
  const [template] = await db
    .insert(services)
    .values({ organizationId: session.organizationId, name: chosen.name })
    .returning();

  if (chosen.suggestedRequirements.length > 0) {
    await db.insert(serviceDocumentRequirements).values(
      chosen.suggestedRequirements.map((r, index) => ({
        serviceId: template.id,
        name: r.name,
        position: index,
      }))
    );
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.created_from_library",
    description: `התבנית "${template.name}" נוצרה מספריית התבניות`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/templates/${template.id}`);
}

// Idempotent-ish first-run seeding, mirroring
// src/lib/businessTypes.ts's seedStarterBusinessTypes pattern: called every
// time the Templates page loads, only actually creates anything when the
// organization has zero templates. Deliberately checks emptiness rather
// than a persisted "already seeded" flag — simpler, and the one edge case
// it accepts (a user deletes all 3 examples, then a later visit reseeds
// them) is low-stakes and easily deleted again, not worth a new schema
// column for.
export async function seedExampleTemplates(organizationId: string) {
  const db = await getDb();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.organizationId, organizationId));
  if (count > 0) return;

  const organization = await getOrganization(organizationId);
  if (!organization) return;

  const library = await suggestTemplateLibrary(
    organization.businessCategory,
    organization.businessCategoryCustomLabel
  );
  const toSeed = library.slice(0, 3);

  for (const entry of toSeed) {
    const [template] = await db
      .insert(services)
      .values({ organizationId, name: entry.name })
      .returning();
    if (entry.suggestedRequirements.length > 0) {
      await db.insert(serviceDocumentRequirements).values(
        entry.suggestedRequirements.map((r, index) => ({
          serviceId: template.id,
          name: r.name,
          position: index,
        }))
      );
    }
  }

  await recordAuditEvent({
    organizationId,
    eventType: "template.examples_seeded",
    description: `${toSeed.length} תבניות לדוגמה נוצרו אוטומטית`,
    actorType: "system",
  });
}
