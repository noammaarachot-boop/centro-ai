"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { clientServices, clients, services } from "@/db/schema";
import { recordAuditEvent } from "@/lib/audit";
import { requireSession } from "@/lib/auth/session";
import { getOrganization } from "@/lib/data/organizations";
import {
  AUTO_CLASSIFY_CONFIDENCE,
  classifyClientBusinessType,
  SUGGESTED_CONFIDENCE,
  type BusinessTypeCandidate,
} from "@/lib/ai/businessTypeClassifier";
import {
  assignClientsToBusinessType,
  createBusinessType,
  getLearnedSynonyms,
  getSuggestedRequirements,
  seedStarterBusinessTypes,
} from "@/lib/businessTypes";

// Milestone 1 ("Manual-Entry Classification Parity"): a client created
// outside the onboarding wizard's bulk import gets the exact same
// classification the wizard already gives imported clients — same
// classifier, same organization-scoped learned synonyms, same confidence
// bands (src/lib/ai/businessTypeClassifier.ts). There is no explicit
// business-type field on this form, so this only ever reaches the
// classifier's context-inference layer (the client's name alone) — never
// silently applied below SUGGESTED_CONFIDENCE, exactly like import.
async function classifyAndAssignBusinessType(
  organizationId: string,
  clientId: string,
  clientName: string
) {
  const businessTypeList = await seedStarterBusinessTypes(organizationId);
  const candidates: BusinessTypeCandidate[] = businessTypeList.map((t) => ({
    id: t.id,
    name: t.name,
    canonicalKey: t.canonicalKey,
  }));
  const learnedSynonyms = await getLearnedSynonyms(organizationId);

  const classification = await classifyClientBusinessType(
    { clientName },
    candidates,
    learnedSynonyms
  );

  if (!classification.businessTypeId || classification.confidence < SUGGESTED_CONFIDENCE) {
    return classification;
  }

  await assignClientsToBusinessType(organizationId, [clientId], classification.businessTypeId, {
    confidence: classification.confidence,
  });
  return classification;
}

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

  const classification = await classifyAndAssignBusinessType(
    session.organizationId,
    client.id,
    client.name
  );
  if (classification.businessTypeId) {
    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "client.business_type_classified",
      description:
        classification.confidence >= AUTO_CLASSIFY_CONFIDENCE
          ? `סוג העסק של "${client.name}" זוהה אוטומטית (ביטחון ${classification.confidence}%)`
          : `סוג העסק של "${client.name}" זוהה כהצעה (ביטחון ${classification.confidence}%) — כדאי לוודא`,
      actorType: "ai",
      clientId: client.id,
      metadata: {
        confidence: classification.confidence,
        method: classification.method,
        reason: classification.reason,
      },
    });
  }

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
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
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
      .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
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

  // Both sides of the assignment must belong to this org — otherwise an
  // employee could link their own client to another organization's
  // service (and, from there, snapshot that foreign service's
  // requirement templates into a new Collection Request).
  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
    .limit(1);
  if (!client) redirect("/clients");

  const [service] = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.organizationId, session.organizationId)))
    .limit(1);
  if (!service) redirect(`/clients/${clientId}`);

  await db
    .insert(clientServices)
    .values({ clientId, serviceId })
    .onConflictDoNothing();

  const organization = await getOrganization(session.organizationId);
  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.service_assigned",
    description:
      organization?.workflowType === "one_time" ? "תבנית שויכה ללקוח" : "שירות שויך ללקוח",
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  redirect(`/clients/${clientId}`);
}

export async function unassignService(clientId: string, assignmentId: string) {
  const session = await requireSession();
  const db = await getDb();

  // Join through clients to confirm the assignment's client belongs to
  // this org before deleting — clientServices itself has no
  // organizationId column of its own.
  const [assignment] = await db
    .select({ id: clientServices.id })
    .from(clientServices)
    .innerJoin(clients, eq(clientServices.clientId, clients.id))
    .where(
      and(
        eq(clientServices.id, assignmentId),
        eq(clientServices.clientId, clientId),
        eq(clients.organizationId, session.organizationId)
      )
    )
    .limit(1);
  if (!assignment) redirect(`/clients/${clientId}`);

  await db.delete(clientServices).where(eq(clientServices.id, assignmentId));

  const organization = await getOrganization(session.organizationId);
  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "client.service_unassigned",
    description:
      organization?.workflowType === "one_time"
        ? "שיוך תבנית הוסר מהלקוח"
        : "שיוך שירות הוסר מהלקוח",
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  redirect(`/clients/${clientId}`);
}

// The client detail page's manual business-type control — covers both
// picking an existing type and (via `newTypeName`) creating one inline,
// mirroring src/app/onboarding/actions.ts's assignBusinessTypeAction, but
// scoped to exactly one client rather than the wizard's bulk-select flow.
// Kept separate rather than shared: the two forms serve genuinely
// different UIs (a multi-select wizard step vs. a single-client detail
// page control) — assignClientsToBusinessType itself, the one function
// that actually changes clients.businessTypeId, is the real shared seam.
export async function setClientBusinessType(clientId: string, formData: FormData) {
  const session = await requireSession();
  const db = await getDb();

  const [client] = await db
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.organizationId, session.organizationId)))
    .limit(1);
  if (!client) redirect("/clients");

  const newTypeName = String(formData.get("newTypeName") ?? "").trim();
  let businessTypeId = String(formData.get("businessTypeId") ?? "");

  if (newTypeName) {
    const created = await createBusinessType(session.organizationId, newTypeName, {
      isCustom: true,
      seedRequirements: getSuggestedRequirements(newTypeName),
    });
    businessTypeId = created.id;

    await recordAuditEvent({
      organizationId: session.organizationId,
      eventType: "business_type.created",
      description: `סוג עסק "${newTypeName}" נוצר`,
      actorType: "employee",
      actorUserId: session.userId,
    });
  }

  if (!businessTypeId) redirect(`/clients/${clientId}`);

  // A human explicitly choosing this — unlike the classifier — is
  // definitionally certain, not a guess (assignClientsToBusinessType
  // defaults `confidence` to 100 when not given).
  await assignClientsToBusinessType(session.organizationId, [clientId], businessTypeId);

  await recordAuditEvent({
    organizationId: session.organizationId,
    eventType: "clients.business_type_assigned",
    description: `סוג העסק של "${client.name}" עודכן ידנית`,
    actorType: "employee",
    actorUserId: session.userId,
    clientId,
  });

  redirect(`/clients/${clientId}`);
}
