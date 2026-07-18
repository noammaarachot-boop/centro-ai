"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { clientServices, clients } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";

export interface ClientFormState {
  error?: string;
  fieldErrors?: {
    name?: string;
    phone?: string;
  };
}

function readClientInput(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    phone: String(formData.get("phone") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    notes: String(formData.get("notes") ?? "").trim(),
  };
}

function validateClientInput(input: ReturnType<typeof readClientInput>) {
  const fieldErrors: ClientFormState["fieldErrors"] = {};
  if (!input.name) fieldErrors.name = "נא להזין שם לקוח.";
  if (!input.phone) fieldErrors.phone = "נא להזין מספר טלפון (וואטסאפ).";
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : null;
}

export async function createClient(
  _prevState: ClientFormState,
  formData: FormData
): Promise<ClientFormState> {
  const session = await requireSession();
  const input = readClientInput(formData);
  const fieldErrors = validateClientInput(input);
  if (fieldErrors) return { fieldErrors };

  const db = await getDb();

  const [duplicate] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.organizationId, session.organizationId),
        eq(clients.phone, input.phone)
      )
    )
    .limit(1);
  if (duplicate) {
    return { fieldErrors: { phone: "מספר טלפון זה כבר משויך ללקוח אחר." } };
  }

  const [client] = await db
    .insert(clients)
    .values({
      organizationId: session.organizationId,
      name: input.name,
      phone: input.phone,
      email: input.email || null,
      notes: input.notes || null,
    })
    .returning();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.created",
    description: `הלקוח "${client.name}" נוצר`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: client.id,
  });

  redirect(`/clients/${client.id}`);
}

export async function updateClient(
  clientId: string,
  _prevState: ClientFormState,
  formData: FormData
): Promise<ClientFormState> {
  const session = await requireSession();
  const input = readClientInput(formData);
  const fieldErrors = validateClientInput(input);
  if (fieldErrors) return { fieldErrors };

  const db = await getDb();

  const [duplicate] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.organizationId, session.organizationId),
        eq(clients.phone, input.phone),
        ne(clients.id, clientId)
      )
    )
    .limit(1);
  if (duplicate) {
    return { fieldErrors: { phone: "מספר טלפון זה כבר משויך ללקוח אחר." } };
  }

  const [client] = await db
    .update(clients)
    .set({
      name: input.name,
      phone: input.phone,
      email: input.email || null,
      notes: input.notes || null,
      updatedAt: new Date(),
    })
    .where(eq(clients.id, clientId))
    .returning();

  if (!client) return { error: "הלקוח לא נמצא." };

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.updated",
    description: `פרטי הלקוח "${client.name}" עודכנו`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId: client.id,
  });

  redirect(`/clients/${client.id}`);
}

export async function deleteClient(clientId: string) {
  const session = await requireSession();
  const db = await getDb();

  try {
    const [client] = await db
      .delete(clients)
      .where(eq(clients.id, clientId))
      .returning();

    if (client) {
      await recordAuditEvent({
        organizationId: session.organizationId,
        eventType: "client.deleted",
        description: `הלקוח "${client.name}" נמחק`,
        actorType: "employee",
        actorUserId: session.userId,
      });
    }
  } catch {
    redirect(`/clients/${clientId}?error=has-history`);
  }

  redirect("/clients");
}

export async function assignService(clientId: string, formData: FormData) {
  const session = await requireSession();
  const serviceId = String(formData.get("serviceId") ?? "");
  if (!serviceId) redirect(`/clients/${clientId}`);

  const db = await getDb();

  await db
    .insert(clientServices)
    .values({ clientId, serviceId })
    .onConflictDoNothing();

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.service_assigned",
    description: "שירות שויך ללקוח",
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  redirect(`/clients/${clientId}`);
}

export async function unassignService(clientId: string, assignmentId: string) {
  const session = await requireSession();
  const db = await getDb();

  await db.delete(clientServices).where(eq(clientServices.id, assignmentId));

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.service_unassigned",
    description: "שיוך שירות הוסר מהלקוח",
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  redirect(`/clients/${clientId}`);
}
