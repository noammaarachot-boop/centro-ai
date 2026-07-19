import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  businessTypes,
  clientServices,
  clients,
  serviceDocumentRequirements,
  services,
} from "@/db/schema";

/**
 * "Business Type" is a product/UI concept only (Epic 3) — every row here is
 * backed by exactly one auto-managed Service of the same name, so the rest
 * of the app (Collection Requests, requirement snapshots, the dashboard)
 * never needs to know Business Types exist; it just sees Services, exactly
 * as before. This module is the one seam that manages that pairing —
 * everything else (src/app/onboarding/steps/*) only ever calls through
 * here, never touches `services`/`serviceDocumentRequirements` directly,
 * so a future epic can change how types are seeded/classified without
 * touching the wizard UI.
 */

interface SuggestedRequirement {
  name: string;
  defaultChecked: boolean;
}

interface StarterBusinessType {
  name: string;
  suggestedRequirements: SuggestedRequirement[];
}

// A recommended starting template, not enforced logic — every requirement
// it produces becomes a real service_document_requirements row the moment
// it's seeded; nothing at runtime re-reads this list. Reasonable defaults
// for an Israeli accounting-firm pilot; fully editable per office from
// Step 6 (or later, /services/[id]).
//
// Names are Hebrew — the canonical, stored value (business_types.name and
// its backing services.name), not just a display label — because every
// wizard step and /services render this field directly, so there is no
// separate translation layer to keep in sync. These exact strings must
// match src/lib/ai/businessTypeClassifier.ts's BUSINESS_TYPE_SYNONYMS keys.
export const STARTER_BUSINESS_TYPES: StarterBusinessType[] = [
  {
    name: 'חברה בע"מ',
    suggestedRequirements: [
      { name: "חשבוניות הוצאה", defaultChecked: true },
      { name: "חשבוניות הכנסה", defaultChecked: true },
      { name: "דפי חשבון בנק", defaultChecked: true },
      { name: "דפי כרטיס אשראי", defaultChecked: true },
      { name: "דוחות שכר", defaultChecked: true },
      { name: "טפסי עובדים", defaultChecked: true },
      { name: 'דוחות מע"מ', defaultChecked: true },
      { name: "הוצאות רכב", defaultChecked: false },
      { name: "קופה קטנה", defaultChecked: false },
    ],
  },
  {
    name: "עוסק מורשה",
    suggestedRequirements: [
      { name: "חשבוניות הוצאה", defaultChecked: true },
      { name: "חשבוניות הכנסה", defaultChecked: true },
      { name: "דפי חשבון בנק", defaultChecked: true },
      { name: 'דוחות מע"מ', defaultChecked: true },
      { name: "דפי כרטיס אשראי", defaultChecked: false },
      { name: "הוצאות רכב", defaultChecked: false },
      { name: "קופה קטנה", defaultChecked: false },
    ],
  },
  {
    name: "עוסק פטור",
    suggestedRequirements: [
      { name: "חשבוניות הכנסה", defaultChecked: true },
      { name: "דפי חשבון בנק", defaultChecked: true },
      { name: "חשבוניות הוצאה", defaultChecked: false },
      { name: "קופה קטנה", defaultChecked: false },
    ],
  },
  {
    name: "עמותה",
    suggestedRequirements: [
      { name: "דפי חשבון בנק", defaultChecked: true },
      { name: "חשבוניות הכנסה", defaultChecked: true },
      { name: "חשבוניות הוצאה", defaultChecked: true },
      { name: "דוח שנתי", defaultChecked: true },
      { name: "דוחות שכר", defaultChecked: false },
      { name: "טפסי עובדים", defaultChecked: false },
    ],
  },
  {
    name: "שכר בלבד",
    suggestedRequirements: [
      { name: "דוחות שכר", defaultChecked: true },
      { name: "טפסי עובדים", defaultChecked: true },
      { name: "דפי חשבון בנק", defaultChecked: false },
    ],
  },
];

export function getSuggestedRequirements(typeName: string): SuggestedRequirement[] {
  return (
    STARTER_BUSINESS_TYPES.find((t) => t.name === typeName)?.suggestedRequirements ?? []
  );
}

export async function listBusinessTypes(organizationId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: businessTypes.id,
      name: businessTypes.name,
      serviceId: businessTypes.serviceId,
      isCustom: businessTypes.isCustom,
      clientCount: sql<number>`count(${clients.id})::int`,
    })
    .from(businessTypes)
    .leftJoin(clients, eq(clients.businessTypeId, businessTypes.id))
    .where(eq(businessTypes.organizationId, organizationId))
    .groupBy(businessTypes.id)
    .orderBy(businessTypes.name);
  return rows;
}

export async function getBusinessType(organizationId: string, businessTypeId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(businessTypes)
    .where(
      and(eq(businessTypes.id, businessTypeId), eq(businessTypes.organizationId, organizationId))
    )
    .limit(1);
  return row ?? null;
}

// Creates the Business Type's backing Service in the same call — callers
// never create a bare `services` row for a business type themselves.
export async function createBusinessType(
  organizationId: string,
  name: string,
  options: { isCustom?: boolean; seedRequirements?: SuggestedRequirement[] } = {}
) {
  const db = await getDb();
  const [service] = await db
    .insert(services)
    .values({ organizationId, name })
    .returning({ id: services.id });

  const [businessType] = await db
    .insert(businessTypes)
    .values({
      organizationId,
      name,
      serviceId: service.id,
      isCustom: options.isCustom ?? true,
    })
    .returning();

  const toSeed = (options.seedRequirements ?? []).filter((r) => r.defaultChecked);
  if (toSeed.length > 0) {
    await db.insert(serviceDocumentRequirements).values(
      toSeed.map((r) => ({ serviceId: service.id, name: r.name }))
    );
  }

  return businessType;
}

// Idempotent — safe to call every time Step 5 loads. Only creates the
// starter types an org doesn't already have (matched by name), so a user
// who deletes/renames one during the wizard doesn't get it silently
// recreated on the next step transition.
export async function seedStarterBusinessTypes(organizationId: string) {
  const existing = await listBusinessTypes(organizationId);
  const existingNames = new Set(existing.map((t) => t.name));

  for (const starter of STARTER_BUSINESS_TYPES) {
    if (existingNames.has(starter.name)) continue;
    await createBusinessType(organizationId, starter.name, {
      isCustom: false,
      seedRequirements: starter.suggestedRequirements,
    });
  }

  return listBusinessTypes(organizationId);
}

// Sets the classification and, since Business Type implies its backing
// Service, assigns the client to that service too — a wizard-classified
// client is immediately ready for real Collection Requests, no separate
// manual "assign service" step required afterward.
export async function assignClientsToBusinessType(
  organizationId: string,
  clientIds: string[],
  businessTypeId: string
) {
  if (clientIds.length === 0) return;
  const db = await getDb();

  const businessType = await getBusinessType(organizationId, businessTypeId);
  if (!businessType) return;

  for (const clientId of clientIds) {
    await db
      .update(clients)
      .set({ businessTypeId, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)));

    await db
      .insert(clientServices)
      .values({ clientId, serviceId: businessType.serviceId })
      .onConflictDoNothing();
  }
}

export async function listUnclassifiedClients(organizationId: string) {
  const db = await getDb();
  return db
    .select()
    .from(clients)
    .where(and(eq(clients.organizationId, organizationId), sql`${clients.businessTypeId} is null`))
    .orderBy(clients.name);
}

export async function listClientsByBusinessType(
  organizationId: string,
  businessTypeId: string
) {
  const db = await getDb();
  return db
    .select()
    .from(clients)
    .where(
      and(eq(clients.organizationId, organizationId), eq(clients.businessTypeId, businessTypeId))
    )
    .orderBy(clients.name);
}
