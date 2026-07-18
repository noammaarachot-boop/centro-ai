"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
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
    .where(eq(services.id, serviceId))
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
      .where(eq(services.id, serviceId))
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

export async function addRequirement(serviceId: string, formData: FormData) {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();

  if (!name) redirect(`/services/${serviceId}?error=requirement-name`);

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

  redirect(`/services/${serviceId}`);
}

export async function removeRequirement(
  serviceId: string,
  requirementId: string
) {
  const session = await requireSession();
  const db = await getDb();

  await db
    .delete(serviceDocumentRequirements)
    .where(eq(serviceDocumentRequirements.id, requirementId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "service.requirement_removed",
    description: "דרישת מסמך הוסרה מהשירות",
    actorType: "employee",
    actorUserId: session.userId,
  });

  redirect(`/services/${serviceId}`);
}
