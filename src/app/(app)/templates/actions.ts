"use server";

import { and, asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import {
  clientServices,
  clients,
  collectionRequests,
  serviceDocumentRequirements,
  services,
} from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { snapshotServiceRequirements } from "@/lib/collectionRequestStateMachine";
import { attemptScheduledDelivery } from "@/lib/scheduledSend";
import { parseRequirementSemantics, requiresClarification } from "@/lib/ai/requirementSemantics";
import { findClientIdsWithActiveRequest, hasActiveRequestsForTemplate } from "@/lib/data/templates";

// Product Evolution M5 — a Template is a bare `services` row for a
// one-time-workflow organization (see ARCHITECTURE.md); these actions are
// thin, Template-branded wrappers around the exact same DB operations
// src/app/(app)/services/actions.ts already has, differing only in audit
// copy and redirect targets — kept as their own file rather than literally
// calling into services/actions.ts so each domain's audit trail reads
// clearly on its own.
//
// First-Send Journey rework — this file (and its sibling Template* components
// in this same directory) is no longer routed at /templates: that route is
// retired. The functions here are reused as-is by the Collection Requests
// wizard (/collections/new) and management page (/collections/manage/[id]),
// which is now the definition's "home" — only the redirect targets changed.
// Kept in place rather than moved, to keep this rework's diff minimal.

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
  if (!template) redirect("/collections");
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
    .values({
      organizationId: session.organizationId,
      name,
      description: description || null,
      collectionMode: "on_demand",
    })
    .returning();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.created",
    description: `בקשת האיסוף "${template.name}" נוצרה`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  // First-Send Journey — continues the Collection Requests wizard rather
  // than landing on the management page; this action now only ever runs
  // from the wizard's "What" step (see createCollectionRequestDraft below
  // for the combined create+seed-documents path used there instead).
  redirect(`/collections/new?draft=${template.id}`);
}

// First-Send Journey — the Collection Requests wizard's "What will be
// sent?" step needs to create the definition AND its initial document list
// in one submit (the design shows suggested documents pre-checked
// alongside the name field, not as a separate step). createTemplate above
// only ever took a name/description, and addTemplateRequirement below only
// ever adds one document to an *existing* definition — neither fit this
// specific first-run shape, so this combines them rather than forcing the
// wizard into two round-trips for what the user experiences as one step.
export interface CollectionRequestDraftState {
  error?: string;
  fieldErrors?: { name?: string };
}

export async function createCollectionRequestDraft(
  _prevState: CollectionRequestDraftState,
  formData: FormData
): Promise<CollectionRequestDraftState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const requirementNames = formData
    .getAll("requirementName")
    .map((v) => String(v).trim())
    .filter(Boolean);

  if (!name) return { fieldErrors: { name: "נא להזין שם לבקשת האיסוף." } };

  const db = await getDb();
  const [draft] = await db
    .insert(services)
    .values({ organizationId: session.organizationId, name, collectionMode: "on_demand" })
    .returning();

  if (requirementNames.length > 0) {
    // Semantic requirement engine (src/lib/ai/requirementSemantics.ts) —
    // parsed and stored honestly here, but never blocks this bulk wizard
    // step on ambiguity (unlike addRequirement/addTemplateRequirement's
    // single-item synchronous clarification): a requirement parsed with
    // low confidence is still saved, with that low confidence recorded —
    // resolveRequirementSemantics (requirementSemanticsActions.ts) is what
    // lets the office user resolve it, from the template management page
    // that follows immediately after this step and before the request is
    // ever actually sent to a client.
    const specs = await Promise.all(requirementNames.map((reqName) => parseRequirementSemantics(reqName, requirementNames)));
    await db.insert(serviceDocumentRequirements).values(
      requirementNames.map((reqName, index) => ({
        serviceId: draft.id,
        name: reqName,
        position: index,
        requiredCount: specs[index].requiredCount,
        semanticSpec: specs[index],
      }))
    );
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.created",
    description: `בקשת האיסוף "${draft.name}" נוצרה`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/collections/new?draft=${draft.id}&step=who`);
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
    description: `פרטי בקשת האיסוף "${template.name}" עודכנו`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/collections/manage/${template.id}`);
}

// "Mark, never delete" (services.retiredAt's own doc comment) — a template
// is a reusable definition, while every collectionRequests row it ever
// produced is its own independent historical instance (BR-002: a request
// snapshots its requirements at creation time, never live-references the
// template). Retiring a template must never touch a single historical
// request, message, document, or audit event — it only removes the
// template itself from the gallery and refuses to start new requests from
// it. Blocked only by requests that are genuinely still open right now
// (hasActiveRequestsForTemplate, the same NON_TERMINAL_STATUSES every
// other "is this template in use" check in the app already uses) — having
// been used hundreds of times historically is never itself a reason to
// block deletion.
export async function deleteTemplate(templateId: string) {
  const session = await requireSession();
  const db = await getDb();

  await getOrgScopedTemplate(session.organizationId, templateId);

  const hasActiveRequests = await hasActiveRequestsForTemplate(session.organizationId, templateId);
  if (hasActiveRequests) {
    redirect(`/collections/manage/${templateId}?error=has-active-requests`);
  }

  const [retired] = await db
    .update(services)
    .set({ retiredAt: new Date() })
    .where(and(eq(services.id, templateId), eq(services.organizationId, session.organizationId)))
    .returning({ name: services.name });

  if (retired) {
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "template.deleted",
      description: `התבנית "${retired.name}" נמחקה`,
      actorType: "employee",
      actorUserId: session.userId,
    });
  }

  redirect("/collections");
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
  if (!original) redirect("/collections");

  const [copy] = await db
    .insert(services)
    .values({
      organizationId: session.organizationId,
      name: `${original.name} (העתק)`,
      description: original.description,
      collectionMode: "on_demand",
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
    description: `בקשת האיסוף "${original.name}" שוכפלה ל"${copy.name}"`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/collections/manage/${copy.id}`);
}

export async function addTemplateRequirement(templateId: string, formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    redirect(`/collections/manage/${templateId}?error=requirement-name`);
  }

  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  const existingNames = (
    await db
      .select({ name: serviceDocumentRequirements.name })
      .from(serviceDocumentRequirements)
      .where(eq(serviceDocumentRequirements.serviceId, templateId))
  ).map((r) => r.name);
  const spec = await parseRequirementSemantics(name, existingNames);

  if (requiresClarification(spec)) {
    const params = new URLSearchParams({ clarifyName: name, clarifyQuestion: spec.clarifyingQuestion ?? "" });
    redirect(`/collections/manage/${templateId}?${params.toString()}`);
  }

  await db.insert(serviceDocumentRequirements).values({
    serviceId: templateId,
    name,
    requiredCount: spec.requiredCount,
    semanticSpec: spec,
  });

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.requirement_added",
    description: `מסמך "${name}" נוסף לבקשת האיסוף`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { requiredCount: spec.requiredCount, periodType: spec.periodType },
  });

  refresh();
}

// The clarification counterpart to addTemplateRequirement above — mirrors
// addRequirementWithClarification (services/actions.ts) exactly.
export async function addTemplateRequirementWithClarification(templateId: string, formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const clarificationAnswer = String(formData.get("clarificationAnswer") ?? "").trim();
  if (!name) redirect(`/collections/manage/${templateId}?error=requirement-name`);

  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  const existingNames = (
    await db
      .select({ name: serviceDocumentRequirements.name })
      .from(serviceDocumentRequirements)
      .where(eq(serviceDocumentRequirements.serviceId, templateId))
  ).map((r) => r.name);
  const clarifiedText = clarificationAnswer ? `${name} — הבהרת המשתמש: ${clarificationAnswer}` : name;
  const spec = await parseRequirementSemantics(clarifiedText, existingNames);
  const resolvedSpec = { ...spec, originalText: name };

  await db.insert(serviceDocumentRequirements).values({
    serviceId: templateId,
    name,
    requiredCount: resolvedSpec.requiredCount,
    semanticSpec: resolvedSpec,
  });

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.requirement_added",
    description: `מסמך "${name}" נוסף לבקשת האיסוף`,
    actorType: "employee",
    actorUserId: session.userId,
    metadata: { requiredCount: resolvedSpec.requiredCount, periodType: resolvedSpec.periodType },
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

// First-Send Journey — the one-click "start from library" flow
// (createTemplateFromLibrary) and the auto-seeded sample templates
// (seedExampleTemplates) both lived on the retired /templates list page.
// Removed rather than kept dead: the wizard's "What will be sent?" step
// now shows the same suggestTemplateLibrary suggestions inline, pre-checked,
// as part of creating the user's own first real Collection Request (see
// createCollectionRequestDraft above and /collections/new) — a seeded
// sample a user has to notice and delete works against "guide them to
// their own real first send as fast as possible."

// Product Evolution M6 — client assignment. Reuses `client_services`
// directly (the same join table clients/actions.ts's assignService already
// writes) rather than a new table: "clients assigned to this template" and
// "clients assigned to this service" are the same relationship, and a
// Template already IS a bare services row. The same template can be
// assigned to one or many clients simultaneously; a client can belong to
// multiple templates.
export async function assignClientsToTemplate(templateId: string, formData: FormData) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const clientIds = formData.getAll("clientId").map(String).filter(Boolean);
  if (clientIds.length === 0) {
    refresh();
    return;
  }

  const db = await getDb();
  for (const clientId of clientIds) {
    await db
      .insert(clientServices)
      .values({ clientId, serviceId: templateId })
      .onConflictDoNothing();
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.clients_assigned",
    description: `${clientIds.length} לקוחות שויכו לבקשת האיסוף`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// The template detail page's "create a new client" shortcut — same
// required fields (name, phone) and duplicate-phone handling as the
// standalone /clients/new form, just one step closer to the actual task
// (assigning them to this template) instead of a separate round trip.
// A duplicate phone number assigns the *existing* client with that number
// rather than erroring, since the accountant's actual intent here is
// "make sure this person is on this template," not strict deduplication.
export async function createAndAssignClientToTemplate(templateId: string, formData: FormData) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const notes = String(formData.get("notes") ?? "").trim();
  if (!name || !phone) {
    redirect(`/collections/manage/${templateId}?error=client-fields`);
  }

  const db = await getDb();
  const [duplicate] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.organizationId, session.organizationId), eq(clients.phone, phone)))
    .limit(1);

  let clientId: string;
  if (duplicate) {
    clientId = duplicate.id;
  } else {
    const [created] = await db
      .insert(clients)
      .values({
        organizationId: session.organizationId,
        name,
        phone,
        notes: notes || null,
      })
      .returning({ id: clients.id });
    clientId = created.id;

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "clients.created",
      description: `הלקוח/ה "${name}" נוצר/ה מתוך בקשת איסוף`,
      actorType: "employee",
      actorUserId: session.userId,
      clientId,
    });
  }

  await db.insert(clientServices).values({ clientId, serviceId: templateId }).onConflictDoNothing();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.clients_assigned",
    description: `הלקוח/ה "${name}" שויך/ה לבקשת האיסוף`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  refresh();
}

export async function removeClientFromTemplate(templateId: string, assignmentId: string) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  // Join through clients to confirm the assignment's client belongs to
  // this org before deleting — client_services itself has no
  // organizationId column of its own (same check clients/actions.ts's
  // unassignService already does for the reverse direction).
  const [assignment] = await db
    .select({ id: clientServices.id })
    .from(clientServices)
    .innerJoin(clients, eq(clientServices.clientId, clients.id))
    .where(
      and(
        eq(clientServices.id, assignmentId),
        eq(clientServices.serviceId, templateId),
        eq(clients.organizationId, session.organizationId)
      )
    )
    .limit(1);
  if (!assignment) {
    refresh();
    return;
  }

  await db.delete(clientServices).where(eq(clientServices.id, assignmentId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "template.client_removed",
    description: "לקוח הוסר מבקשת האיסוף",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// Product Evolution M7 — "Send Request: Now or Schedule," the action that
// makes a Template do something. For every selected client: creates a
// genuinely ordinary collection_requests row (reusing snapshotServiceRequirements,
// the exact same recurring-workflow function — a one-time request is not a
// different kind of row, just one whose service happens to be a Template)
// with `scheduledAt` set to either now (Send Now) or the chosen future
// moment (Schedule). "Send Now" then attempts delivery synchronously so
// the employee sees a real result immediately; a future-dated schedule is
// left for src/lib/scheduler.ts's cron tick to deliver when it comes due.
// Either way, delivery itself is the one shared function
// (attemptScheduledDelivery) — there is no separate "send immediately"
// code path to keep in sync with the scheduled one.
// First-Send Journey — `redirectTo` lets the Collection Requests wizard's
// Review step land on its own Success screen (/collections/new?draft=...
// &step=success) after sending, while the manage page (/collections/manage/
// [id]) keeps landing back on itself with a "sent" banner, same as before —
// same action, same DB effect, just a different place to report the result.
// Defaults to the manage page so every existing call site keeps working
// unchanged.
//
// `newClientName`/`newClientPhone` (both optional) let one submit both add
// a brand-new client and send to them — the "בקשות איסוף" template
// gallery's combined "שלח ללקוחות" action passes these; every existing
// caller (the wizard, the old two-step manage-page flow) never sets them,
// so this branch is a no-op for them. Duplicate phone reuses the existing
// client, same dedup rule as createAndAssignClientToTemplate.
//
// Duplicate-active guard — the real gap this now closes: previously this
// unconditionally created a new collection_requests row for every
// submitted clientId, even one who already had a non-terminal request from
// this exact template (the old UI defaulted to every assigned client
// pre-checked, so simply re-opening the page and clicking Send again
// silently duplicated the request and re-sent a real WhatsApp message).
// Now: any client already carrying a non-terminal request for this
// template (NON_TERMINAL_STATUSES — draft/active/waiting_for_client/
// processing/escalated) is skipped, counted separately, and reported back
// explicitly via `alreadyActive` — never silently absorbed into `sent`.
export async function sendTemplateRequest(templateId: string, formData: FormData) {
  const session = await requireSession();
  await getOrgScopedTemplate(session.organizationId, templateId);

  const db = await getDb();
  const explicitClientIds = formData.getAll("clientId").map(String).filter(Boolean);
  const newClientName = String(formData.get("newClientName") ?? "").trim();
  const newClientPhone = String(formData.get("newClientPhone") ?? "").trim();
  const sendMode = String(formData.get("sendMode") ?? "now");
  const redirectTo = formData.get("redirectTo")?.toString() || `/collections/manage/${templateId}`;
  const sep = redirectTo.includes("?") ? "&" : "?";

  const clientIds = [...explicitClientIds];
  if (newClientName && newClientPhone) {
    const [duplicate] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.organizationId, session.organizationId), eq(clients.phone, newClientPhone)))
      .limit(1);

    let newClientId: string;
    if (duplicate) {
      newClientId = duplicate.id;
    } else {
      const [created] = await db
        .insert(clients)
        .values({ organizationId: session.organizationId, name: newClientName, phone: newClientPhone })
        .returning({ id: clients.id });
      newClientId = created.id;

      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "clients.created",
        description: `הלקוח/ה "${newClientName}" נוצר/ה מתוך בקשת איסוף`,
        actorType: "employee",
        actorUserId: session.userId,
        clientId: newClientId,
      });
    }
    if (!clientIds.includes(newClientId)) clientIds.push(newClientId);
  }

  if (clientIds.length === 0) {
    redirect(`${redirectTo}${sep}error=no-clients-selected`);
  }

  let scheduledAt = new Date();
  if (sendMode === "schedule") {
    const raw = String(formData.get("scheduledFor") ?? "");
    const parsed = raw ? new Date(raw) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
      redirect(`${redirectTo}${sep}error=invalid-schedule`);
    }
    scheduledAt = parsed;
  }

  const [template] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, templateId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!template) redirect("/collections");
  // A retired template (services.retiredAt set — see deleteTemplate) is
  // already gone from the gallery; refuse to start a brand-new request
  // from it even via a direct call, same "no new automation from a
  // retired definition" rule deletion itself is for.
  if (template.retiredAt) redirect(`${redirectTo}${sep}error=template-deleted`);

  // Never send a generic "please send the required documents" message: a
  // Collection Request must carry a concrete, user-defined requirement
  // list. If this service has no document requirements defined at all,
  // block the whole send and tell the user to define documents first
  // (surfaced in the UI via ?error=no_active_document_requirements). The
  // requirement list itself is org-scoped (serviceId belongs to this org's
  // template, already verified above), never a hardcoded default.
  const definedRequirements = await db
    .select({ id: serviceDocumentRequirements.id })
    .from(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.serviceId, templateId));
  if (definedRequirements.length === 0) {
    console.log("[document-collection] document_collection_send_blocked", {
      organizationId: session.organizationId,
      serviceId: templateId,
      reason: "no_active_document_requirements",
    });
    redirect(`${redirectTo}${sep}error=no_active_document_requirements`);
  }

  const periodLabel = `${template.name} — ${new Date().toLocaleDateString("he-IL")}`;
  let sentCount = 0;
  let scheduledCount = 0;

  const clientIdsWithActiveRequest = await findClientIdsWithActiveRequest(session.organizationId, templateId, clientIds);
  const alreadyActiveCount = clientIdsWithActiveRequest.size;
  const clientIdsToSend = clientIds.filter((id) => !clientIdsWithActiveRequest.has(id));

  for (const clientId of clientIdsToSend) {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
      .limit(1);
    if (!client) continue;

    const [collectionRequest] = await db
      .insert(collectionRequests)
      .values({
        organizationId: session.organizationId,
        clientId,
        serviceId: templateId,
        periodLabel,
        status: "draft",
        scheduledAt,
      })
      .returning();

    await snapshotServiceRequirements(collectionRequest.id, templateId, session.organizationId, clientId);

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "collection_request.created",
      description: `נפתחה בקשת איסוף "${template.name}"`,
      actorType: "employee",
      actorUserId: session.userId,
      clientId,
      collectionRequestId: collectionRequest.id,
    });

    if (sendMode === "now") {
      // "Send Now" is a human-initiated (manual) action — always delivers,
      // never gated by documentCollectionEnabled. (A future-scheduled send
      // is delivered later by the cron, which stays "automated".)
      const delivered = await attemptScheduledDelivery(
        session.organizationId,
        collectionRequest.id,
        clientId,
        "manual"
      );
      if (delivered) sentCount += 1;
      else scheduledCount += 1; // outside business hours - queued for the next tick
    } else {
      scheduledCount += 1;
    }
  }

  redirect(`${redirectTo}${sep}sent=${sentCount}&scheduled=${scheduledCount}&alreadyActive=${alreadyActiveCount}`);
}
