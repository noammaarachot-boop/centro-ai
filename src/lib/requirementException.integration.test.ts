import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// "I don't have this document" end-to-end (mandatory scenarios #3/#4/#5):
// reporting a missing document opens a real, auditable employee exception
// instead of auto-completing or endlessly re-nagging; the employee's own
// waive/alternative decision recomputes the request accordingly.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const resolveLanguageModel = vi.fn();
const generateObject = vi.fn();
vi.mock("@/lib/aiCore/providers/resolveModel", () => ({
  resolveLanguageModel: (...args: unknown[]) => resolveLanguageModel(...args),
}));
vi.mock("ai", () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
}));

const { openRequirementException, resolveRequirementException } = await import("./requirementException");
const { checkCompletionGate } = await import("./collectionRequestStateMachine");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  resolveLanguageModel.mockReset();
  generateObject.mockReset();
});

async function seedRequestWithOneRequirement(requirementName = "אישור שכירות") {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p", status: "active" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: requirementName, requiredCount: 1 })
    .returning();
  return { orgId: org.id, clientId: clientRow.id, requestId: request.id, conversationId: conversation.id, requirement };
}

describe("openRequirementException (mandatory #3)", () => {
  it("marks the requirement as a reported exception with the client's own wording, and never auto-completes the request", async () => {
    const { orgId, clientId, requestId, conversationId, requirement } = await seedRequestWithOneRequirement();

    await openRequirementException({
      organizationId: orgId,
      clientId,
      conversationId,
      collectionRequestId: requestId,
      requirementId: requirement.id,
      clientWording: "אין לי את אישור השכירות",
    });

    const [updated] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, requirement.id));
    expect(updated.exceptionStatus).toBe("reported_missing");
    expect(updated.exceptionNote).toBe("אין לי את אישור השכירות");
    expect(updated.exceptionCreatedAt).not.toBeNull();

    // Never auto-completed — a genuine exception still blocks completion
    // until an employee decides.
    const gateError = await checkCompletionGate(requestId);
    expect(gateError).not.toBeNull();

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(auditRows.some((r) => r.eventType === "requirement.exception_reported")).toBe(true);
  });
});

describe("resolveRequirementException — waive (mandatory #4)", () => {
  it("waiving the only outstanding requirement recomputes the request as satisfied and completes it", async () => {
    const { orgId, requestId, requirement } = await seedRequestWithOneRequirement();
    await db
      .update(schema.collectionRequestRequirements)
      .set({ exceptionStatus: "reported_missing", exceptionNote: "אין לי", exceptionCreatedAt: new Date() })
      .where(eq(schema.collectionRequestRequirements.id, requirement.id));

    const result = await resolveRequirementException({
      organizationId: orgId,
      requirementId: requirement.id,
      decision: "waive",
    });
    expect(result.ok).toBe(true);

    const [updated] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, requirement.id));
    expect(updated.exceptionStatus).toBe("waived");

    expect(await checkCompletionGate(requestId)).toBeNull();
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(request.status).toBe("completed");
  });
});

describe("resolveRequirementException — request_alternative (mandatory #5)", () => {
  it("rewrites the requirement to the employee's alternative document and clears the exception", async () => {
    const { orgId, requestId, requirement } = await seedRequestWithOneRequirement();
    await db
      .update(schema.collectionRequestRequirements)
      .set({ exceptionStatus: "reported_missing", exceptionNote: "אין לי", exceptionCreatedAt: new Date() })
      .where(eq(schema.collectionRequestRequirements.id, requirement.id));

    resolveLanguageModel.mockResolvedValueOnce({ modelId: "fake" });
    generateObject.mockResolvedValueOnce({
      object: {
        documentType: "אישור עבודה",
        requiredCount: 1,
        periodType: "none",
        explicitPeriods: null,
        relativeMonths: null,
        samePeriodAllowed: false,
        distinctPeriodsRequired: false,
        distinctPeopleRequired: false,
        expectedPersonOrCompany: null,
        validityRequirement: null,
        supportingDocumentRelationship: null,
        freeTextConstraints: null,
        interpretationConfidence: 0.9,
        clarifyingQuestion: null,
      },
    });

    const result = await resolveRequirementException({
      organizationId: orgId,
      requirementId: requirement.id,
      decision: "request_alternative",
      alternativeText: "אישור עבודה",
    });
    expect(result.ok).toBe(true);

    const [updated] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, requirement.id));
    expect(updated.name).toBe("אישור עבודה");
    expect(updated.exceptionStatus).toBeNull();
    expect(updated.exceptionNote).toBeNull();

    // Not satisfied yet — the client still needs to actually send the new
    // alternative document; this only ever changes what's being asked for.
    expect(await checkCompletionGate(requestId)).not.toBeNull();
  });

  it("rejects an empty alternative instead of silently doing nothing", async () => {
    const { orgId, requirement } = await seedRequestWithOneRequirement();
    const result = await resolveRequirementException({
      organizationId: orgId,
      requirementId: requirement.id,
      decision: "request_alternative",
      alternativeText: "   ",
    });
    expect(result.ok).toBe(false);
  });
});

describe("resolveRequirementException — contact_client / leave_open", () => {
  it("both suppress the exception state change without satisfying the requirement", async () => {
    const { orgId, requirement: r1 } = await seedRequestWithOneRequirement("מסמך א");
    const contactResult = await resolveRequirementException({
      organizationId: orgId,
      requirementId: r1.id,
      decision: "contact_client",
    });
    expect(contactResult.ok).toBe(true);
    const [updated1] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, r1.id));
    expect(updated1.exceptionStatus).toBe("will_contact_client");

    const { orgId: orgId2, requirement: r2 } = await seedRequestWithOneRequirement("מסמך ב");
    const leaveResult = await resolveRequirementException({
      organizationId: orgId2,
      requirementId: r2.id,
      decision: "leave_open",
    });
    expect(leaveResult.ok).toBe(true);
    const [updated2] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.id, r2.id));
    expect(updated2.exceptionStatus).toBe("left_open");
  });
});
