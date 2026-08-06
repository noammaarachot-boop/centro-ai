import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

// Semantic requirement engine — snapshotServiceRequirements is the one
// place a reusable template's parsed semanticSpec/requiredCount actually
// reach a real Collection Request, with any month-only period ("06" for
// "יוני") resolved into a concrete "MM/YYYY" anchored to this specific
// request's own creation moment.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { snapshotServiceRequirements } = await import("./collectionRequestStateMachine");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedServiceWithRequirement(
  requirementOverrides: Partial<{ requiredCount: number; semanticSpec: RequirementSemanticSpec | null }>
) {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  await db.insert(schema.serviceDocumentRequirements).values({
    serviceId: service.id,
    name: "תלוש שכר",
    requiredCount: requirementOverrides.requiredCount ?? 1,
    semanticSpec: requirementOverrides.semanticSpec ?? null,
  });
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  return { orgId: org.id, clientId: client.id, serviceId: service.id, requestId: request.id };
}

describe("snapshotServiceRequirements — semantic requirement engine propagation", () => {
  it("copies requiredCount and semanticSpec from the template onto the request's own requirement row", async () => {
    const spec: RequirementSemanticSpec = {
      originalText: "3 תלושי שכר של 3 החודשים האחרונים",
      documentType: "תלוש שכר",
      requiredCount: 3,
      periodType: "relative",
      explicitPeriods: null,
      relativePeriod: { kind: "last_n_months", n: 3 },
      samePeriodAllowed: false,
      distinctPeriodsRequired: true,
      distinctPeopleRequired: false,
      expectedPersonOrCompany: null,
      validityRequirement: null,
      supportingDocumentRelationship: null,
      freeTextConstraints: null,
      interpretationConfidence: 0.9,
      clarifyingQuestion: null,
    };
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 3, semanticSpec: spec });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    expect(row.requiredCount).toBe(3);
    const snapshotSpec = row.semanticSpec as RequirementSemanticSpec;
    expect(snapshotSpec.periodType).toBe("relative");
    expect(snapshotSpec.distinctPeriodsRequired).toBe(true);
  });

  it("resolves a month-only explicitPeriods entry into a concrete MM/YYYY anchored to the request's own creation date", async () => {
    const spec: RequirementSemanticSpec = {
      originalText: "3 תלושי שכר של חודש יוני",
      documentType: "תלוש שכר",
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06"], // month-only, no year — template has no request date to anchor to
      relativePeriod: null,
      samePeriodAllowed: true,
      distinctPeriodsRequired: false,
      distinctPeopleRequired: false,
      expectedPersonOrCompany: null,
      validityRequirement: null,
      supportingDocumentRelationship: null,
      freeTextConstraints: null,
      interpretationConfidence: 0.9,
      clarifyingQuestion: null,
    };
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 3, semanticSpec: spec });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    const snapshotSpec = row.semanticSpec as RequirementSemanticSpec;
    expect(snapshotSpec.explicitPeriods).toHaveLength(1);
    expect(snapshotSpec.explicitPeriods![0]).toMatch(/^06\/\d{4}$/);
  });

  it("a requirement with no semanticSpec (legacy row) snapshots with a null spec, requiredCount preserved", async () => {
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 1, semanticSpec: null });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    expect(row.requiredCount).toBe(1);
    expect(row.semanticSpec).toBeNull();
  });
});
