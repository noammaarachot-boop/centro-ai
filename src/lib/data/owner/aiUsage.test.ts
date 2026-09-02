import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * "How much did Anthropic cost me today, which organization spent it, and
 * what did the system do to cause it?"
 *
 * That is the question this reporting layer exists to answer, so these tests
 * ask it directly rather than checking intermediate shapes.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { getAiUsageReport, getAiUsageForOrganization, getMostExpensiveAiCalls, startOfToday } =
  await import("./aiUsage");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgA: string;
let orgB: string;

beforeEach(async () => {
  await db.delete(schema.aiUsageEvents);
  await db.delete(schema.organizations);
  const [a] = await db.insert(schema.organizations).values({ name: "משרד א" }).returning();
  const [b] = await db.insert(schema.organizations).values({ name: "משרד ב" }).returning();
  orgA = a.id;
  orgB = b.id;
});

const WINDOW = new Date(Date.now() - 60 * 60 * 1000);

async function seedCall(overrides: Partial<typeof schema.aiUsageEvents.$inferInsert> = {}) {
  await db.insert(schema.aiUsageEvents).values({
    organizationId: orgA,
    operation: "document.vision_classify",
    provider: "anthropic",
    modelId: "claude-sonnet-5",
    inputTokens: 1_000_000,
    outputTokens: 0,
    totalTokens: 1_000_000,
    latencyMs: 1200,
    success: true,
    attempt: 1,
    environment: "production",
    ...overrides,
  });
}

describe("what did it cost, and what caused it", () => {
  it("prices a million input tokens at the model's own rate", async () => {
    // claude-sonnet-5 is $3 per million input in the pricing table.
    await seedCall();

    const report = await getAiUsageReport(WINDOW);

    expect(report.totalCalls).toBe(1);
    expect(report.totalEstimatedCostUsd).toBeCloseTo(3, 5);
  });

  it("attributes cost to the operation that caused it", async () => {
    await seedCall({ operation: "document.vision_classify" });
    await seedCall({ operation: "conversation.understand_turn", inputTokens: 500_000 });

    const report = await getAiUsageReport(WINDOW);
    const byOperation = Object.fromEntries(report.byOperation.map((r) => [r.key, r.estimatedCostUsd]));

    expect(byOperation["document.vision_classify"]).toBeCloseTo(3, 5);
    expect(byOperation["conversation.understand_turn"]).toBeCloseTo(1.5, 5);
    // Sorted most expensive first — the answer to "what is costing me money".
    expect(report.byOperation[0].key).toBe("document.vision_classify");
  });

  it("attributes cost to the organization that spent it", async () => {
    await seedCall({ organizationId: orgA });
    await seedCall({ organizationId: orgB, inputTokens: 2_000_000 });

    const report = await getAiUsageReport(WINDOW);
    const rows = Object.fromEntries(report.byOrganization.map((r) => [r.label, r.estimatedCostUsd]));

    expect(rows["משרד א"]).toBeCloseTo(3, 5);
    expect(rows["משרד ב"]).toBeCloseTo(6, 5);
  });

  it("prices cache reads far below fresh input", async () => {
    // A cached read is billed at a fraction of fresh input; counting it at
    // full price would overstate the bill.
    await seedCall({ inputTokens: 1_000_000, cachedInputTokens: 1_000_000 });

    const report = await getAiUsageReport(WINDOW);

    expect(report.totalEstimatedCostUsd).toBeLessThan(1);
    expect(report.totalEstimatedCostUsd).toBeGreaterThan(0);
  });

  it("reports a model it cannot price as unavailable, never as free", async () => {
    await seedCall({ modelId: "claude-some-future-model" });

    const report = await getAiUsageReport(WINDOW);

    expect(report.hasUnpricedModels).toBe(true);
    expect(report.byModel[0].estimatedCostUsd).toBeNull();
    // The token counts are still real and still shown.
    expect(report.byModel[0].inputTokens).toBe(1_000_000);
  });
});

describe("what the report warns about", () => {
  it("counts calls nobody is accountable for", async () => {
    await seedCall({ organizationId: null });

    const report = await getAiUsageReport(WINDOW);

    expect(report.unattributedCalls).toBe(1);
  });

  it("counts retries separately from calls", async () => {
    await seedCall({ attempt: 1 });
    await seedCall({ attempt: 2 });
    await seedCall({ attempt: 3 });

    const report = await getAiUsageReport(WINDOW);

    expect(report.totalCalls, "the provider billed three times").toBe(3);
    expect(report.byOperation[0].retriedCalls, "two of them were retries").toBe(2);
  });

  it("counts failures, which still cost input tokens", async () => {
    await seedCall({ success: false, errorKind: "APICallError" });

    const report = await getAiUsageReport(WINDOW);

    expect(report.byOperation[0].failedCalls).toBe(1);
  });

  it("surfaces spend from a non-production environment", async () => {
    // The same API key was configured in production and present locally, so
    // "is something other than the deployed product spending this" has to be
    // answerable from data.
    await seedCall({ environment: "development" });
    await seedCall({ environment: "production" });

    const report = await getAiUsageReport(WINDOW);
    const environments = report.byEnvironment.map((r) => r.key).sort();

    expect(environments).toEqual(["development", "production"]);
  });

  it("counts calls that reported no tokens", async () => {
    await seedCall({ inputTokens: null, outputTokens: null, totalTokens: null, success: false });

    const report = await getAiUsageReport(WINDOW);

    expect(report.callsWithoutTokenData).toBe(1);
  });

  it("a quiet day reads as zero, not as missing data", async () => {
    const report = await getAiUsageReport(WINDOW);

    expect(report.totalCalls).toBe(0);
    expect(report.totalEstimatedCostUsd).toBe(0);
    expect(report.byOperation).toEqual([]);
  });

  it("ignores anything outside the window", async () => {
    await seedCall({ createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) });

    expect((await getAiUsageReport(WINDOW)).totalCalls).toBe(0);
    expect(startOfToday(new Date("2026-09-02T15:00:00")).getHours()).toBe(0);
  });
});

describe("tenant isolation", () => {
  it("a per-organization report never includes another organization", async () => {
    await seedCall({ organizationId: orgA, operation: "a" });
    await seedCall({ organizationId: orgB, operation: "b" });

    const forA = await getAiUsageForOrganization(orgA, WINDOW);

    expect(forA.map((r) => r.key)).toEqual(["a"]);
  });

  it("an organization with no usage gets an empty report, not everyone's", async () => {
    await seedCall({ organizationId: orgA });

    expect(await getAiUsageForOrganization(orgB, WINDOW)).toEqual([]);
  });
});

describe("finding the expensive call", () => {
  it("ranks individual calls by tokens, so an outlier is findable", async () => {
    // An average hides the one document that cost fifty times the rest.
    await seedCall({ operation: "small", inputTokens: 1000, totalTokens: 1000 });
    await seedCall({ operation: "huge", inputTokens: 900_000, totalTokens: 900_000 });

    const [top] = await getMostExpensiveAiCalls(WINDOW, 5);

    expect(top.operation).toBe("huge");
    expect(top.organizationName).toBe("משרד א");
    expect(top.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("carries identifiers only — never anything a prompt could hide in", async () => {
    await seedCall();

    const [row] = await getMostExpensiveAiCalls(WINDOW, 1);

    expect(Object.keys(row)).not.toContain("content");
    expect(Object.keys(row)).not.toContain("prompt");
  });
});
