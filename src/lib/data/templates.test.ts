import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { CollectionRequestStatus } from "@/lib/collectionRequestStateMachine";

// Proves the template gallery's numbers are a direct projection of the
// real engine — never a manual counter, never a second completion
// algorithm. Every fixture here uses real collectionRequests rows and the
// real NON_TERMINAL_STATUSES / computeRequirementsProgress the state
// machine itself defines.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { listTemplatesWithActiveCounts, findClientIdsWithActiveRequest, listActiveRequestsForTemplate } =
  await import("./templates");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrg() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  return org.id;
}

async function seedClient(orgId: string, name = "לקוח") {
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name, phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  return client.id;
}

async function seedTemplate(orgId: string, name: string, requirementNames: string[] = []) {
  const [template] = await db
    .insert(schema.services)
    .values({ organizationId: orgId, name, collectionMode: "on_demand" })
    .returning();
  if (requirementNames.length > 0) {
    await db
      .insert(schema.serviceDocumentRequirements)
      .values(requirementNames.map((n) => ({ serviceId: template.id, name: n })));
  }
  return template.id;
}

async function seedRequest(
  orgId: string,
  clientId: string,
  templateId: string,
  status: CollectionRequestStatus
) {
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId, serviceId: templateId, periodLabel: "p", status })
    .returning();
  return request.id;
}

describe("listTemplatesWithActiveCounts — real projection of collectionRequests/serviceDocumentRequirements", () => {
  it("counts only non-terminal requests as active, and reflects the real requirement count", async () => {
    const orgId = await seedOrg();
    const templateId = await seedTemplate(orgId, "מסמכים לפתיחת תיק", ["תעודת זהות", "תלוש שכר"]);
    const clientA = await seedClient(orgId, "לקוח א");
    const clientB = await seedClient(orgId, "לקוח ב");
    const clientC = await seedClient(orgId, "לקוח ג");
    const clientD = await seedClient(orgId, "לקוח ד");

    await seedRequest(orgId, clientA, templateId, "active");
    await seedRequest(orgId, clientB, templateId, "waiting_for_client");
    await seedRequest(orgId, clientC, templateId, "completed");
    await seedRequest(orgId, clientD, templateId, "cancelled");

    const templates = await listTemplatesWithActiveCounts(orgId);
    const summary = templates.find((t) => t.id === templateId);
    expect(summary?.requirementCount).toBe(2);
    expect(summary?.activeRequestCount).toBe(2);
  });

  it("only lists on_demand templates, never recurring services", async () => {
    const orgId = await seedOrg();
    await seedTemplate(orgId, "תבנית on_demand");
    const [recurring] = await db
      .insert(schema.services)
      .values({ organizationId: orgId, name: "שירות מחזורי", collectionMode: "recurring" })
      .returning();

    const templates = await listTemplatesWithActiveCounts(orgId);
    expect(templates.some((t) => t.id === recurring.id)).toBe(false);
    expect(templates.some((t) => t.name === "תבנית on_demand")).toBe(true);
  });

  it("a template with zero requests shows activeRequestCount 0, not an error", async () => {
    const orgId = await seedOrg();
    const templateId = await seedTemplate(orgId, "תבנית חדשה");

    const templates = await listTemplatesWithActiveCounts(orgId);
    expect(templates.find((t) => t.id === templateId)?.activeRequestCount).toBe(0);
  });
});

describe("findClientIdsWithActiveRequest — the same predicate the duplicate guard relies on", () => {
  it("returns exactly the clients with a non-terminal request for this template, scoped per template", async () => {
    const orgId = await seedOrg();
    const templateA = await seedTemplate(orgId, "תבנית א");
    const templateB = await seedTemplate(orgId, "תבנית ב");
    const clientActive = await seedClient(orgId, "פעיל");
    const clientCompleted = await seedClient(orgId, "הושלם");
    const clientOtherTemplate = await seedClient(orgId, "תבנית אחרת");

    await seedRequest(orgId, clientActive, templateA, "active");
    await seedRequest(orgId, clientCompleted, templateA, "completed");
    await seedRequest(orgId, clientOtherTemplate, templateB, "active");

    const result = await findClientIdsWithActiveRequest(orgId, templateA, [
      clientActive,
      clientCompleted,
      clientOtherTemplate,
    ]);

    expect(result.has(clientActive)).toBe(true);
    expect(result.has(clientCompleted)).toBe(false);
    expect(result.has(clientOtherTemplate)).toBe(false);
  });
});

describe("listActiveRequestsForTemplate — real client/status/progress, never a parallel calculation", () => {
  it("reflects real satisfied/missing requirements via computeRequirementsProgress", async () => {
    const orgId = await seedOrg();
    const templateId = await seedTemplate(orgId, "תבנית");
    const clientId = await seedClient(orgId, "לקוח");
    const requestId = await seedRequest(orgId, clientId, templateId, "active");
    await db.insert(schema.collectionRequestRequirements).values([
      { collectionRequestId: requestId, name: "תעודת זהות" },
      { collectionRequestId: requestId, name: "תלוש שכר" },
    ]);
    const [idReq] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.name, "תעודת זהות"));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId: idReq.id,
      status: "approved",
      fileName: "id.pdf",
    });

    const requests = await listActiveRequestsForTemplate(orgId, templateId);
    expect(requests).toHaveLength(1);
    expect(requests[0].clientName).toBe("לקוח");
    expect(requests[0].satisfiedCount).toBe(1);
    expect(requests[0].totalCount).toBe(2);
    expect(requests[0].missingRequirementNames).toEqual(["תלוש שכר"]);
  });

  it("excludes completed/cancelled requests from the active list", async () => {
    const orgId = await seedOrg();
    const templateId = await seedTemplate(orgId, "תבנית");
    const clientId = await seedClient(orgId, "לקוח");
    await seedRequest(orgId, clientId, templateId, "completed");

    expect(await listActiveRequestsForTemplate(orgId, templateId)).toHaveLength(0);
  });
});
