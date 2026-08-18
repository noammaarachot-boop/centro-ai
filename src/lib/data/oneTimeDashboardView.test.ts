import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Proves the broken-reference edge case (a collectionRequestId reaching
// this view with no matching client/service summary — e.g. a race between
// the two reads, or a genuine data-integrity gap) is handled explicitly:
// the row is dropped from what's rendered (never a fabricated client
// name), but it is never silent — captureError is called with enough
// context to find it.

let db: Database;
const capturedErrors: Array<{ error: unknown; context?: Record<string, unknown> }> = [];

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

vi.mock("@/lib/monitoring/errorReporting", () => ({
  captureError: vi.fn((error: unknown, context?: Record<string, unknown>) => {
    capturedErrors.push({ error, context });
  }),
}));

const PHANTOM_COLLECTION_REQUEST_ID = "00000000-0000-4000-8000-000000000099";

vi.mock("@/lib/data/dashboardReadModel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./dashboardReadModel")>();
  return {
    ...actual,
    // Simulates a broken reference reaching the view layer — a real
    // NeedsReviewItem the union already found, plus one pointing at a
    // collectionRequestId that does not (or no longer) exist. Everything
    // else (computeRequirementsProgress, getWaitingForClientCount, etc.)
    // stays real/unmocked.
    getItemsNeedingReview: vi.fn(async (organizationId: string) => {
      const real = await actual.getItemsNeedingReview(organizationId);
      return [
        ...real,
        {
          collectionRequestId: PHANTOM_COLLECTION_REQUEST_ID,
          clientId: "00000000-0000-4000-8000-000000000098",
          reasons: [{ kind: "employee_question" as const, detail: "שאלה כלשהי", occurredAt: new Date() }],
        },
      ];
    }),
  };
});

const { getOneTimeDashboardView } = await import("./oneTimeDashboardView");
const { captureError } = await import("@/lib/monitoring/errorReporting");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

describe("getOneTimeDashboardView — broken collectionRequestId reference", () => {
  it("drops the phantom item from the rendered list without fabricating a client, and reports it observably", async () => {
    capturedErrors.length = 0;

    const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
    const [client] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "לקוח אמיתי", phone: "+972500000001" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "active" })
      .returning();
    const conversation = await db
      .insert(schema.conversations)
      .values({ organizationId: org.id, clientId: client.id, collectionRequestId: request.id, status: "open" })
      .returning();
    await db.insert(schema.employeeReviewItems).values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      conversationId: conversation[0].id,
      clientQuestion: "שאלה אמיתית",
      category: "other",
      status: "pending",
    });

    const view = await getOneTimeDashboardView(org.id);

    // The real item is rendered normally.
    expect(view.needsAttention.some((row) => row.collectionRequestId === request.id)).toBe(true);
    // The phantom item never appears — no invented client name/title.
    expect(view.needsAttention.some((row) => row.collectionRequestId === PHANTOM_COLLECTION_REQUEST_ID)).toBe(false);
    expect(view.needsAttention.every((row) => !row.title.includes("undefined"))).toBe(true);

    // But it was not silent: captureError was called with the broken id.
    expect(captureError).toHaveBeenCalled();
    const relevant = capturedErrors.find(
      (entry) => entry.context?.collectionRequestId === PHANTOM_COLLECTION_REQUEST_ID
    );
    expect(relevant).toBeDefined();
    expect(relevant?.context).toMatchObject({
      organizationId: org.id,
      collectionRequestId: PHANTOM_COLLECTION_REQUEST_ID,
      context: "needsAttention",
    });

    // The KPI count still reflects the full upstream union (unchanged
    // meaning — see dashboardReadModel.getItemsNeedingReview) even though
    // the phantom row was dropped from the rendered list.
    expect(view.kpis.needsReviewCount).toBe(view.needsAttention.length + 1);
  });
});
