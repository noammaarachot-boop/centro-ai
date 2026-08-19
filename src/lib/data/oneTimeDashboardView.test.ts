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

const { getOneTimeDashboardView, listActiveRequestsFull, listCompletedThisWeekFull, listNeedsReviewRequests } =
  await import("./oneTimeDashboardView");
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

// KPI drill-down lists (issue: every KPI card used to link to /collections,
// the template gallery, regardless of which tile was clicked) — each list
// function must return every matching request (never capped, unlike the
// homepage's own inProgress table) using the exact same status definitions
// the KPI counts themselves are built from.
async function seedRequestForDrillDown(orgId: string, clientName: string, status: string, completedAt?: Date) {
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name: clientName, phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "שירות" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId: client.id, serviceId: service.id, periodLabel: "p", status: status as never, completedAt })
    .returning();
  return request.id;
}

describe("listActiveRequestsFull — the 'בקשות פעילות' KPI's own real drill-down, uncapped", () => {
  it("returns every active/waiting_for_client/processing request, excludes escalated/completed/cancelled/draft", async () => {
    const [org] = await db.insert(schema.organizations).values({ name: "Org2" }).returning();
    const activeId = await seedRequestForDrillDown(org.id, "פעיל", "active");
    const waitingId = await seedRequestForDrillDown(org.id, "ממתין", "waiting_for_client");
    const processingId = await seedRequestForDrillDown(org.id, "בעיבוד", "processing");
    await seedRequestForDrillDown(org.id, "הוסלם", "escalated");
    await seedRequestForDrillDown(org.id, "הושלם", "completed", new Date());
    await seedRequestForDrillDown(org.id, "בוטל", "cancelled");
    await seedRequestForDrillDown(org.id, "טיוטה", "draft");

    const rows = await listActiveRequestsFull(org.id);
    const ids = rows.map((r) => r.collectionRequestId);
    expect(ids.sort()).toEqual([activeId, waitingId, processingId].sort());
  });
});

describe("listCompletedThisWeekFull — the 'הושלמו השבוע' KPI's own real drill-down, uncapped", () => {
  it("returns only requests completed within the last 7 days, excludes older completions and non-completed statuses", async () => {
    const [org] = await db.insert(schema.organizations).values({ name: "Org3" }).returning();
    const recentId = await seedRequestForDrillDown(org.id, "הושלם השבוע", "completed", new Date(Date.now() - 2 * 24 * 60 * 60 * 1000));
    await seedRequestForDrillDown(org.id, "הושלם מזמן", "completed", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await seedRequestForDrillDown(org.id, "פעיל", "active");

    const rows = await listCompletedThisWeekFull(org.id);
    expect(rows.map((r) => r.collectionRequestId)).toEqual([recentId]);
  });
});

describe("listNeedsReviewRequests — the 'דורש בדיקה' KPI's own real drill-down, same union getItemsNeedingReview already computes", () => {
  it("returns every real needs-review item, not just the homepage's own (already uncapped) list", async () => {
    const [org] = await db.insert(schema.organizations).values({ name: "Org4" }).returning();
    const [client] = await db
      .insert(schema.clients)
      .values({ organizationId: org.id, name: "לקוח", phone: "+972500000099" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "escalated", escalationReason: "לא ענה" })
      .returning();

    const rows = await listNeedsReviewRequests(org.id);
    expect(rows.some((r) => r.collectionRequestId === request.id)).toBe(true);
  });
});
