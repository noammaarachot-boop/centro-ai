import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiUsageEvents, organizations } from "@/db/schema";
import { estimateCostUsd } from "@/lib/owner/aiPricing";

/**
 * "How much did Anthropic cost me today, which organization spent it, and
 * what did the system do to cause it?"
 *
 * That question had no answer before ai_usage_events existed, and this is
 * where it gets one. Every figure below is a read over real recorded calls —
 * nothing here estimates traffic or infers activity from other tables.
 *
 * Money is computed HERE, never stored. Providers report tokens, not prices;
 * a price written into a row is wrong the day the provider changes it, and
 * silently so. Computing at read time means a pricing correction re-prices
 * history instead of leaving it frozen. A model missing from the pricing
 * table still reports real token counts with a null cost — never a silent
 * zero, which would read as "this was free".
 */
export interface AiUsageBreakdownRow {
  key: string;
  label: string;
  calls: number;
  failedCalls: number;
  retriedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostUsd: number | null;
}

export interface AiUsageReport {
  windowStart: Date;
  totalCalls: number;
  totalEstimatedCostUsd: number;
  hasUnpricedModels: boolean;
  /** Calls that reached the provider but recorded no token counts. */
  callsWithoutTokenData: number;
  /** Calls that ran with no tenant attached — money nobody is accountable for. */
  unattributedCalls: number;
  byOperation: AiUsageBreakdownRow[];
  byOrganization: AiUsageBreakdownRow[];
  byModel: AiUsageBreakdownRow[];
  byEnvironment: AiUsageBreakdownRow[];
}

interface RawGroup {
  key: string | null;
  label: string | null;
  provider: string;
  modelId: string;
  calls: number;
  failedCalls: number;
  retriedCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/**
 * Cost for one group, priced per (provider, model).
 *
 * Cache reads are subtracted from the input total before pricing, because a
 * cached read is billed at a fraction of fresh input. Counting it at full
 * price would overstate the bill; ignoring the field entirely would too.
 * When the provider reported no cache figures this is simply the input total.
 */
function priceGroup(group: RawGroup): number | null {
  const freshInput = Math.max(0, group.inputTokens - group.cachedInputTokens);
  const fresh = estimateCostUsd(group.provider, group.modelId, freshInput, group.outputTokens);
  if (fresh === null) return null;
  // Anthropic prices a cache read at roughly a tenth of fresh input. Applied
  // as an explicit, visible factor rather than hidden inside the pricing
  // table, which is keyed only by model.
  const cached = estimateCostUsd(group.provider, group.modelId, group.cachedInputTokens, 0);
  return fresh + (cached ?? 0) * 0.1;
}

function foldGroups(groups: RawGroup[]): { rows: AiUsageBreakdownRow[]; total: number; unpriced: boolean } {
  const byKey = new Map<string, AiUsageBreakdownRow>();
  let total = 0;
  let unpriced = false;

  for (const group of groups) {
    const key = group.key ?? "(none)";
    const cost = priceGroup(group);
    if (cost === null) unpriced = true;
    else total += cost;

    const existing = byKey.get(key);
    if (existing) {
      existing.calls += group.calls;
      existing.failedCalls += group.failedCalls;
      existing.retriedCalls += group.retriedCalls;
      existing.inputTokens += group.inputTokens;
      existing.outputTokens += group.outputTokens;
      existing.cachedInputTokens += group.cachedInputTokens;
      existing.estimatedCostUsd =
        existing.estimatedCostUsd === null || cost === null ? null : existing.estimatedCostUsd + cost;
    } else {
      byKey.set(key, {
        key,
        label: group.label ?? key,
        calls: group.calls,
        failedCalls: group.failedCalls,
        retriedCalls: group.retriedCalls,
        inputTokens: group.inputTokens,
        outputTokens: group.outputTokens,
        cachedInputTokens: group.cachedInputTokens,
        estimatedCostUsd: cost,
      });
    }
  }

  const rows = [...byKey.values()].sort(
    (a, b) => (b.estimatedCostUsd ?? 0) - (a.estimatedCostUsd ?? 0) || b.calls - a.calls
  );
  return { rows, total, unpriced };
}

// Every breakdown groups by (provider, model) underneath its own dimension,
// because cost cannot be computed without the model — a single "tokens by
// operation" sum spanning two models cannot be priced at all.
const AGGREGATES = {
  calls: sql<number>`count(*)::int`,
  failedCalls: sql<number>`count(*) filter (where not ${aiUsageEvents.success})::int`,
  retriedCalls: sql<number>`count(*) filter (where ${aiUsageEvents.attempt} > 1)::int`,
  inputTokens: sql<number>`coalesce(sum(${aiUsageEvents.inputTokens}), 0)::int`,
  outputTokens: sql<number>`coalesce(sum(${aiUsageEvents.outputTokens}), 0)::int`,
  cachedInputTokens: sql<number>`coalesce(sum(${aiUsageEvents.cachedInputTokens}), 0)::int`,
} as const;

export async function getAiUsageReport(windowStart: Date): Promise<AiUsageReport> {
  const db = await getDb();
  const inWindow = gte(aiUsageEvents.createdAt, windowStart);

  const [byOperationRaw, byOrganizationRaw, byModelRaw, byEnvironmentRaw, [totals]] = await Promise.all([
    db
      .select({
        key: aiUsageEvents.operation,
        label: aiUsageEvents.operation,
        provider: aiUsageEvents.provider,
        modelId: aiUsageEvents.modelId,
        ...AGGREGATES,
      })
      .from(aiUsageEvents)
      .where(inWindow)
      .groupBy(aiUsageEvents.operation, aiUsageEvents.provider, aiUsageEvents.modelId),

    db
      .select({
        key: aiUsageEvents.organizationId,
        label: organizations.name,
        provider: aiUsageEvents.provider,
        modelId: aiUsageEvents.modelId,
        ...AGGREGATES,
      })
      .from(aiUsageEvents)
      .leftJoin(organizations, eq(organizations.id, aiUsageEvents.organizationId))
      .where(inWindow)
      .groupBy(aiUsageEvents.organizationId, organizations.name, aiUsageEvents.provider, aiUsageEvents.modelId),

    db
      .select({
        key: sql<string>`${aiUsageEvents.provider} || '/' || ${aiUsageEvents.modelId}`,
        label: sql<string>`${aiUsageEvents.provider} || '/' || ${aiUsageEvents.modelId}`,
        provider: aiUsageEvents.provider,
        modelId: aiUsageEvents.modelId,
        ...AGGREGATES,
      })
      .from(aiUsageEvents)
      .where(inWindow)
      .groupBy(aiUsageEvents.provider, aiUsageEvents.modelId),

    db
      .select({
        key: aiUsageEvents.environment,
        label: aiUsageEvents.environment,
        provider: aiUsageEvents.provider,
        modelId: aiUsageEvents.modelId,
        ...AGGREGATES,
      })
      .from(aiUsageEvents)
      .where(inWindow)
      .groupBy(aiUsageEvents.environment, aiUsageEvents.provider, aiUsageEvents.modelId),

    db
      .select({
        totalCalls: sql<number>`count(*)::int`,
        callsWithoutTokenData: sql<number>`count(*) filter (where ${aiUsageEvents.inputTokens} is null)::int`,
        unattributedCalls: sql<number>`count(*) filter (where ${aiUsageEvents.organizationId} is null)::int`,
      })
      .from(aiUsageEvents)
      .where(inWindow),
  ]);

  const byOperation = foldGroups(byOperationRaw);
  const byOrganization = foldGroups(byOrganizationRaw);
  const byModel = foldGroups(byModelRaw);
  const byEnvironment = foldGroups(byEnvironmentRaw);

  return {
    windowStart,
    totalCalls: totals?.totalCalls ?? 0,
    // Taken from the model breakdown: it is the one dimension where every
    // call appears exactly once under a priceable key.
    totalEstimatedCostUsd: byModel.total,
    hasUnpricedModels: byModel.unpriced,
    callsWithoutTokenData: totals?.callsWithoutTokenData ?? 0,
    unattributedCalls: totals?.unattributedCalls ?? 0,
    byOperation: byOperation.rows,
    byOrganization: byOrganization.rows,
    byModel: byModel.rows,
    byEnvironment: byEnvironment.rows,
  };
}

export function startOfToday(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export async function getAiUsageToday(): Promise<AiUsageReport> {
  return getAiUsageReport(startOfToday());
}

export async function getAiUsageLast30Days(): Promise<AiUsageReport> {
  return getAiUsageReport(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
}

/**
 * The most expensive individual calls, for when a total looks wrong.
 *
 * An average hides the one document that cost fifty times the rest; this is
 * how that document gets found. Carries identifiers, never content.
 */
export interface AiUsageCallRow {
  id: string;
  operation: string;
  organizationName: string | null;
  provider: string;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
  attempt: number;
  environment: string;
  collectionRequestId: string | null;
  createdAt: Date;
  estimatedCostUsd: number | null;
}

export async function getMostExpensiveAiCalls(
  windowStart: Date,
  limit = 20
): Promise<AiUsageCallRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      id: aiUsageEvents.id,
      operation: aiUsageEvents.operation,
      organizationName: organizations.name,
      provider: aiUsageEvents.provider,
      modelId: aiUsageEvents.modelId,
      inputTokens: aiUsageEvents.inputTokens,
      outputTokens: aiUsageEvents.outputTokens,
      latencyMs: aiUsageEvents.latencyMs,
      success: aiUsageEvents.success,
      errorKind: aiUsageEvents.errorKind,
      attempt: aiUsageEvents.attempt,
      environment: aiUsageEvents.environment,
      collectionRequestId: aiUsageEvents.collectionRequestId,
      createdAt: aiUsageEvents.createdAt,
    })
    .from(aiUsageEvents)
    .leftJoin(organizations, eq(organizations.id, aiUsageEvents.organizationId))
    .where(and(gte(aiUsageEvents.createdAt, windowStart)))
    .orderBy(desc(sql`coalesce(${aiUsageEvents.totalTokens}, 0)`))
    .limit(limit);

  return rows.map((row) => ({
    ...row,
    estimatedCostUsd: estimateCostUsd(
      row.provider,
      row.modelId,
      row.inputTokens ?? 0,
      row.outputTokens ?? 0
    ),
  }));
}

/**
 * One tenant's own usage, scoped to that tenant.
 *
 * Separate from the owner report on purpose: the owner view spans every
 * organization by design, and a per-tenant caller must never be handed a
 * function that could return another tenant's spend by omitting a filter.
 */
export async function getAiUsageForOrganization(
  organizationId: string,
  windowStart: Date
): Promise<AiUsageBreakdownRow[]> {
  const db = await getDb();
  const rows = await db
    .select({
      key: aiUsageEvents.operation,
      label: aiUsageEvents.operation,
      provider: aiUsageEvents.provider,
      modelId: aiUsageEvents.modelId,
      ...AGGREGATES,
    })
    .from(aiUsageEvents)
    .where(and(eq(aiUsageEvents.organizationId, organizationId), gte(aiUsageEvents.createdAt, windowStart)))
    .groupBy(aiUsageEvents.operation, aiUsageEvents.provider, aiUsageEvents.modelId);

  return foldGroups(rows).rows;
}
