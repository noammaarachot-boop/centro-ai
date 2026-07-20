import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  businessTypeLearnedSynonyms,
  businessTypes,
  clientServices,
  clients,
  organizations,
  serviceDocumentRequirements,
  services,
} from "@/db/schema";
import { suggestStarterBusinessTypes } from "@/lib/ai/businessCategorySuggestions";

// The five standard starter types' stable identity — see business_types'
// schema comment (src/db/schema.ts) for why this exists. Keep in sync with
// src/lib/ai/businessTypeClassifier.ts's BUSINESS_TYPE_SYNONYMS keys.
export type CanonicalBusinessTypeKey =
  | "limited_company"
  | "authorized_dealer"
  | "exempt_dealer"
  | "nonprofit"
  | "payroll_only";

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

export interface SuggestedRequirement {
  name: string;
  defaultChecked: boolean;
}

// canonicalKey is `string | null` (not the narrower CanonicalBusinessTypeKey)
// because Product Evolution M2's AI-suggested starter types for non-
// accounting business categories need their own stable identities outside
// the fixed 5-key accounting union — this type is shared by both. Null is
// valid (an org whose starter type has nothing stable to dedupe against),
// though every real producer today always supplies one.
export interface StarterBusinessType {
  name: string;
  canonicalKey: string | null;
  suggestedRequirements: SuggestedRequirement[];
}

// A recommended starting template, not enforced logic — every requirement
// it produces becomes a real service_document_requirements row the moment
// it's seeded; nothing at runtime re-reads this list. Reasonable defaults
// for an Israeli accounting-firm pilot; fully editable per office from
// Step 6 (or later, /services/[id]).
//
// `name` is Hebrew and fully user-editable post-creation — it's a display
// label, not an identity. `canonicalKey` is the actual, permanent identity
// the classifier matches against (src/lib/ai/businessTypeClassifier.ts) —
// renaming `name` here or on a specific org's row can never again break
// matching, unlike before this epic.
export const STARTER_BUSINESS_TYPES: StarterBusinessType[] = [
  {
    name: 'חברה בע"מ',
    canonicalKey: "limited_company",
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
    canonicalKey: "authorized_dealer",
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
    canonicalKey: "exempt_dealer",
    suggestedRequirements: [
      { name: "חשבוניות הכנסה", defaultChecked: true },
      { name: "דפי חשבון בנק", defaultChecked: true },
      { name: "חשבוניות הוצאה", defaultChecked: false },
      { name: "קופה קטנה", defaultChecked: false },
    ],
  },
  {
    name: "עמותה",
    canonicalKey: "nonprofit",
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
    canonicalKey: "payroll_only",
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
      canonicalKey: businessTypes.canonicalKey,
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
  options: {
    isCustom?: boolean;
    seedRequirements?: SuggestedRequirement[];
    canonicalKey?: string | null;
  } = {}
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
      canonicalKey: options.canonicalKey ?? null,
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
// starter types an org doesn't already have (matched by canonical key, not
// name — an org that renamed "עוסק מורשה" to something else of its own
// still doesn't get a duplicate recreated under it).
//
// Product Evolution M2: which starter types to offer is no longer always
// the hardcoded accounting 5 — it's resolved per the organization's own
// declared businessCategory via suggestStarterBusinessTypes
// (src/lib/ai/businessCategorySuggestions.ts). For "accountant"/
// "tax_advisor" that function returns this exact STARTER_BUSINESS_TYPES
// array unchanged, so this path is byte-identical to before M2 for every
// existing organization. Everything below this point (createBusinessType,
// the classifier, the learning engine) is unaware this branch exists — it
// only ever sees the resulting business_types rows.
export async function seedStarterBusinessTypes(organizationId: string) {
  const existing = await listBusinessTypes(organizationId);
  const existingKeys = new Set(existing.map((t) => t.canonicalKey).filter(Boolean));

  const db = await getDb();
  const [organization] = await db
    .select({
      businessCategory: organizations.businessCategory,
      businessCategoryCustomLabel: organizations.businessCategoryCustomLabel,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  // "accountant"/"tax_advisor" keep the exact hardcoded list (byte-identical
  // to pre-M2 behavior) — resolved here rather than inside
  // suggestStarterBusinessTypes so that module never needs to import
  // STARTER_BUSINESS_TYPES back out of this file.
  const isAccountingCategory =
    organization?.businessCategory === "accountant" ||
    organization?.businessCategory === "tax_advisor";

  const starters =
    !organization || isAccountingCategory
      ? STARTER_BUSINESS_TYPES
      : await suggestStarterBusinessTypes(
          organization.businessCategory,
          organization.businessCategoryCustomLabel
        );

  for (const starter of starters) {
    if (starter.canonicalKey && existingKeys.has(starter.canonicalKey)) continue;
    await createBusinessType(organizationId, starter.name, {
      isCustom: false,
      seedRequirements: starter.suggestedRequirements,
      canonicalKey: starter.canonicalKey,
    });
  }

  return listBusinessTypes(organizationId);
}

// Sets the classification and, since Business Type implies its backing
// Service, assigns the client to that service too — a wizard-classified
// client is immediately ready for real Collection Requests, no separate
// manual "assign service" step required afterward. `confidence` defaults
// to 100 — every caller except the classification pipeline itself
// (src/app/onboarding/actions.ts's importParsedRows, which passes the
// classifier's actual score) is a human decision, which is definitionally
// certain, not a guess.
//
// Epic 4 STEP 7 ("Learn From Corrections"): before updating, looks up
// each client's raw imported business-type text
// (clients.importedBusinessTypeText) and remembers it as a synonym for
// this exact organization + business type — see recordLearnedSynonyms
// below. This is the only call site that ever changes
// clients.businessTypeId, so it's the one place this can never be missed.
export async function assignClientsToBusinessType(
  organizationId: string,
  clientIds: string[],
  businessTypeId: string,
  options: { confidence?: number } = {}
) {
  if (clientIds.length === 0) return;
  const db = await getDb();

  const businessType = await getBusinessType(organizationId, businessTypeId);
  if (!businessType) return;

  const confidence = options.confidence ?? 100;

  const rowsWithText = await db
    .select({ id: clients.id, importedBusinessTypeText: clients.importedBusinessTypeText })
    .from(clients)
    .where(and(eq(clients.organizationId, organizationId), inArray(clients.id, clientIds)));
  await recordLearnedSynonyms(
    organizationId,
    businessTypeId,
    rowsWithText.map((r) => r.importedBusinessTypeText).filter((t): t is string => !!t?.trim())
  );

  for (const clientId of clientIds) {
    await db
      .update(clients)
      .set({ businessTypeId, businessTypeConfidence: confidence, updatedAt: new Date() })
      .where(and(eq(clients.id, clientId), eq(clients.organizationId, organizationId)));

    await db
      .insert(clientServices)
      .values({ clientId, serviceId: businessType.serviceId })
      .onConflictDoNothing();
  }
}

function normalizeSynonymText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

// Upserts one learned-synonym row per distinct source text — re-correcting
// the same text to a different type later simply overwrites it, since a
// human's most recent decision is the one that should apply going forward.
async function recordLearnedSynonyms(
  organizationId: string,
  businessTypeId: string,
  sourceTexts: string[]
) {
  const distinct = [...new Set(sourceTexts.map(normalizeSynonymText))].filter(Boolean);
  if (distinct.length === 0) return;

  const db = await getDb();
  for (const sourceText of distinct) {
    await db
      .insert(businessTypeLearnedSynonyms)
      .values({ organizationId, businessTypeId, sourceText })
      .onConflictDoUpdate({
        target: [businessTypeLearnedSynonyms.organizationId, businessTypeLearnedSynonyms.sourceText],
        set: { businessTypeId, createdAt: new Date() },
      });
  }
}

// Epic 4 STEP 7 — read side. Loaded once per import batch
// (src/app/onboarding/actions.ts) and checked before the global
// deterministic dictionary, since a specific organization's own past
// correction is a stronger, more specific signal than a generic synonym
// list. Scoped strictly to one organization — never shared, never affects
// any other office's classification, no global retraining involved.
export async function getLearnedSynonyms(
  organizationId: string
): Promise<Map<string, string>> {
  const db = await getDb();
  const rows = await db
    .select({
      sourceText: businessTypeLearnedSynonyms.sourceText,
      businessTypeId: businessTypeLearnedSynonyms.businessTypeId,
    })
    .from(businessTypeLearnedSynonyms)
    .where(eq(businessTypeLearnedSynonyms.organizationId, organizationId));
  return new Map(rows.map((r) => [r.sourceText, r.businessTypeId]));
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
