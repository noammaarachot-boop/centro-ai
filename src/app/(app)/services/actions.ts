"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { getDb } from "@/db";
import { serviceDocumentRequirements, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";

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
    return { fieldErrors: { name: "נא להזין שם שירות." } };
  }

  const db = await getDb();
  const [service] = await db
    .insert(services)
    .values({
      organizationId: session.organizationId,
      name,
      description: description || null,
    })
    .returning();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.created",
    description: `השירות "${service.name}" נוצר`,
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
    return { fieldErrors: { name: "נא להזין שם שירות." } };
  }

  const db = await getDb();
  const [service] = await db
    .update(services)
    .set({ name, description: description || null, updatedAt: new Date() })
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .returning();

  if (!service) return { error: "השירות לא נמצא." };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.updated",
    description: `פרטי השירות "${service.name}" עודכנו`,
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
        description: `השירות "${service.name}" נמחק`,
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
    description: `דרישת מסמך "${name}" נוספה לשירות`,
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
    description: "דרישת מסמך הוסרה מהשירות",
    actorType: "employee",
    actorUserId: session.userId,
  });

  refresh();
}
