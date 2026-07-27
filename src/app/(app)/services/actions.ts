"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { clientServices, organizations, serviceDocumentRequirements, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { resolveScheduleConfig } from "@/lib/businessHours";
import { computeInitialCollectionRunAt } from "@/lib/recurringScheduler";

export interface ServiceFormState {
  error?: string;
  fieldErrors?: {
    name?: string;
  };
}

async function getOrgScopedService(organizationId: string, serviceId: string) {
  const db = await getDb();
  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, organizationId)))
    .limit(1);
  if (!service) redirect("/services");
  return service;
}

export async function createService(
  _prevState: ServiceFormState,
  formData: FormData
): Promise<ServiceFormState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) {
    return { fieldErrors: { name: "נא להזין שם." } };
  }

  const db = await getDb();
  const [service] = await db
    .insert(services)
    .values({
      organizationId: session.organizationId,
      name,
      description: description || null,
      collectionMode: "recurring",
      // Product Evolution M9 — a sensible default (monthly), same as
      // createBusinessType (src/lib/businessTypes.ts), so a manually
      // created Recurring Collection works automatically out of the box;
      // always editable afterward via ServiceFrequencyCard.
      collectionFrequencyIntervalMonths: 1,
    })
    .returning();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.created",
    description: `איסוף מחזורי "${service.name}" נוצר`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/services/${service.id}`);
}

export async function updateService(
  serviceId: string,
  _prevState: ServiceFormState,
  formData: FormData
): Promise<ServiceFormState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) {
    return { fieldErrors: { name: "נא להזין שם." } };
  }

  const db = await getDb();
  const [service] = await db
    .update(services)
    .set({ name, description: description || null, updatedAt: new Date() })
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .returning();

  if (!service) return { error: "האיסוף המחזורי לא נמצא." };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.updated",
    description: `פרטי האיסוף המחזורי "${service.name}" עודכנו`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/services/${service.id}`);
}

export async function deleteService(serviceId: string) {
  const session = await requireSession();
  const db = await getDb();

  try {
    const [service] = await db
      .delete(services)
      .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
      .returning();

    if (service) {
      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "service.deleted",
        description: `האיסוף המחזורי "${service.name}" נמחק`,
        actorType: "employee",
        actorUserId: session.userId,
      });
    }
  } catch {
    redirect(`/services/${serviceId}?error=has-history`);
  }

  redirect("/services");
}

// `returnTo` (an optional hidden form field) lets a caller other than the
// service's own page — the onboarding wizard's Step 6 — reuse this action
// unchanged. Both branches of this action always land back on the exact
// page the form was submitted from, so on success it calls refresh()
// (Next.js 16 — see node_modules/next/dist/docs/.../functions/refresh.md)
// and simply returns instead of calling redirect(): redirect() to a URL
// identical to the current one does not reliably force the client router
// to drop its cached RSC payload, so the new requirement wouldn't appear
// until a manual reload. redirect() is only used below for the genuine
// same-page-but-different-query error case, which is a real navigation.
export async function addRequirement(serviceId: string, formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const returnTo = formData.get("returnTo")?.toString();

  if (!name) redirect(returnTo || `/services/${serviceId}?error=requirement-name`);

  await getOrgScopedService(session.organizationId, serviceId);

  const db = await getDb();
  await db.insert(serviceDocumentRequirements).values({
    serviceId,
    name,
    description: description || null,
  });

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.requirement_added",
    description: `דרישת מסמך "${name}" נוספה לתבנית`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// Product Evolution M9 ("a simple pause/resume control for an individual
// recurring collection") — narrower than the org-wide "Deactivate
// automation" switch: pausing one Recurring Collection never touches any
// other Service's automatic cycles or messages (see
// conversationOrchestration.ts's sendOutboundMessage and the recurring
// scheduler, both of which check this specific Service's
// automationPausedAt). Historical data is untouched either way — this
// only ever gates future automatic activity.
export async function pauseServiceAutomation(serviceId: string) {
  const session = await requireSession();
  const service = await getOrgScopedService(session.organizationId, serviceId);

  const db = await getDb();
  await db
    .update(services)
    .set({ automationPausedAt: new Date(), updatedAt: new Date() })
    .where(eq(services.id, service.id));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.automation_paused",
    description: "האוטומציה הושהתה עבור איסוף מחזורי זה",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

export async function resumeServiceAutomation(serviceId: string) {
  const session = await requireSession();
  const service = await getOrgScopedService(session.organizationId, serviceId);

  const db = await getDb();
  await db
    .update(services)
    .set({ automationPausedAt: null, updatedAt: new Date() })
    .where(eq(services.id, service.id));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.automation_resumed",
    description: "האוטומציה חודשה עבור איסוף מחזורי זה",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

// Product Evolution M9 ("Recurring Collection must become truly
// automatic") — sets how often this Service's next cycle opens on its
// own. Recomputes every currently-assigned client's nextCollectionRunAt
// from *today* (not the old schedule) whenever the frequency or anchor
// day changes, so a mid-stream edit takes effect immediately rather than
// silently drifting against a stale baseline — the one deliberate,
// documented edge-case decision here (see recurringScheduler.ts).
export async function updateServiceFrequency(serviceId: string, formData: FormData) {
  const session = await requireSession();
  const db = await getDb();

  const [service] = await db
    .select()
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!service) redirect("/services");

  const rawMonths = Number(formData.get("collectionFrequencyIntervalMonths") ?? 1);
  const intervalMonths = Number.isInteger(rawMonths) ? Math.min(Math.max(rawMonths, 1), 36) : 1;

  await db
    .update(services)
    .set({ collectionFrequencyIntervalMonths: intervalMonths, updatedAt: new Date() })
    .where(eq(services.id, serviceId));

  const [organization] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, session.organizationId))
    .limit(1);
  if (organization) {
    const anchorDay = resolveScheduleConfig(organization, service).collectionDayOfMonth;
    const nextRunAt = computeInitialCollectionRunAt(anchorDay);
    await db
      .update(clientServices)
      .set({ nextCollectionRunAt: nextRunAt })
      .where(eq(clientServices.serviceId, serviceId));
  }

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.frequency_updated",
    description: `תדירות האיסוף המחזורי עודכנה לכל ${intervalMonths} חודשים`,
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}

export async function removeRequirement(serviceId: string, requirementId: string) {
  const session = await requireSession();
  await getOrgScopedService(session.organizationId, serviceId);

  const db = await getDb();
  await db
    .delete(serviceDocumentRequirements)
    .where(
      and(
        eq(serviceDocumentRequirements.id, requirementId),
        eq(serviceDocumentRequirements.serviceId, serviceId)
      )
    );

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.requirement_removed",
    description: "דרישת מסמך הוסרה מהתבנית",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}
