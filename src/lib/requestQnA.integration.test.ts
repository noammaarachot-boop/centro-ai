import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

// Conversational Q&A end-to-end (mandatory scenarios #1/#2): Centro must
// answer "what do I need to send" / "how many are missing" strictly from
// the real requirement specs and real approved-document state on the
// request — never from a generic assumption.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { buildRequirementFacts, answerRequestMessage } = await import("./requestQnA");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

function spec(overrides: Partial<RequirementSemanticSpec>): RequirementSemanticSpec {
  return {
    originalText: "",
    documentType: "תלוש שכר",
    requiredCount: 1,
    periodType: "none",
    explicitPeriods: null,
    relativePeriod: null,
    samePeriodAllowed: false,
    distinctPeriodsRequired: false,
    distinctPeopleRequired: false,
    expectedPersonOrCompany: null,
    validityRequirement: null,
    supportingDocumentRelationship: null,
    freeTextConstraints: null,
    interpretationConfidence: 0.9,
    clarifyingQuestion: null,
    ...overrides,
  };
}

async function seedRequest() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  return { orgId: org.id, clientId: clientRow.id, requestId: request.id };
}

describe("buildRequirementFacts + answerRequestMessage — request_overview (mandatory #1/#2)", () => {
  it("'איזה תלושים אני צריך לשלוח?' answers exactly per the office user's own '3 payslips of June' spec", async () => {
    const { requestId } = await seedRequest();
    await db.insert(schema.collectionRequestRequirements).values({
      collectionRequestId: requestId,
      name: "3 תלושי שכר של חודש יוני",
      requiredCount: 3,
      semanticSpec: spec({
        requiredCount: 3,
        periodType: "explicit",
        explicitPeriods: ["06/2026"],
        samePeriodAllowed: true,
      }),
    });

    const answer = await answerRequestMessage("request_overview", requestId);
    expect(answer).toContain("3 תלושי שכר של חודש יוני");
    expect(answer).toContain("טרם התקבל");
  });

  it("'כמה מסמכים חסרים לי?' reflects real partial progress, never a guessed count", async () => {
    const { orgId, requestId } = await seedRequest();
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({
        collectionRequestId: requestId,
        name: "3 תלושי שכר של שלושת החודשים האחרונים",
        requiredCount: 3,
        semanticSpec: spec({
          requiredCount: 3,
          periodType: "relative",
          relativePeriod: { kind: "last_n_months", n: 3 },
          distinctPeriodsRequired: true,
        }),
      })
      .returning();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirement.id,
      fileName: "payslip1.pdf",
      status: "approved",
      extractedPeriodLabel: "06/2026",
    });

    const facts = await buildRequirementFacts(requestId);
    expect(facts).toHaveLength(1);
    expect(facts[0].satisfiedCount).toBe(1);
    expect(facts[0].requiredCount).toBe(3);
    expect(facts[0].satisfied).toBe(false);

    const answer = await answerRequestMessage("request_overview", requestId);
    expect(answer).toContain("התקבלו 1 מתוך 3");
  });

  it("everything already satisfied is reported honestly as received", async () => {
    const { orgId, requestId } = await seedRequest();
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "תעודת זהות", requiredCount: 1 })
      .returning();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirement.id,
      fileName: "id.pdf",
      status: "approved",
    });

    const answer = await answerRequestMessage("request_overview", requestId);
    expect(answer).toContain("תעודת זהות — התקבל");
  });
});

describe("answerRequestMessage — receipt_check", () => {
  it("'האם המסמך שלחתי התקבל?' names the real most-recent document's real status", async () => {
    const { orgId, requestId } = await seedRequest();
    const [requirement] = await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: requestId, name: "תעודת זהות", requiredCount: 1 })
      .returning();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: requirement.id,
      fileName: "id.pdf",
      status: "approved",
    });

    const answer = await answerRequestMessage("receipt_check", requestId);
    expect(answer).toContain("התקבל ואושר");
    expect(answer).toContain("תעודת זהות");
  });
});

describe("answerRequestMessage — supporting_document", () => {
  it("'האם צריך גם ספח?' reflects exactly what the office user stated, never invents a policy", async () => {
    const { requestId } = await seedRequest();
    await db.insert(schema.collectionRequestRequirements).values({
      collectionRequestId: requestId,
      name: "תעודת זהות",
      requiredCount: 1,
      semanticSpec: spec({ documentType: "תעודת זהות", supportingDocumentRelationship: "כולל ספח עדכני" }),
    });

    const answer = await answerRequestMessage("supporting_document", requestId);
    expect(answer).toContain("ספח עדכני");
  });

  it("no requirement mentions a supporting document -> honest 'not specified', not a guessed yes/no", async () => {
    const { requestId } = await seedRequest();
    await db.insert(schema.collectionRequestRequirements).values({ collectionRequestId: requestId, name: "תעודת זהות" });

    const answer = await answerRequestMessage("supporting_document", requestId);
    expect(answer).toContain("לא צוינה דרישה");
  });
});

describe("answerRequestMessage — file_format", () => {
  it("'אפשר לשלוח PDF?' answers from the real supported extension list", async () => {
    const { requestId } = await seedRequest();
    const answer = await answerRequestMessage("file_format", requestId);
    expect(answer).toContain("PDF");
  });
});
