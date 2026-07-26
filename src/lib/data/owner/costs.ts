import { and, gte, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { aiMessages } from "@/db/schema";
import { estimateCostUsd } from "@/lib/owner/aiPricing";

export interface OwnerAiCostRow {
  provider: string;
  modelId: string;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface OwnerAiCostSummary {
  rows: OwnerAiCostRow[];
  totalEstimatedCostUsd: number;
  hasRowsWithUnknownPricing: boolean;
  messagesWithoutUsageData: number;
}

// aiMessages.metadata.usage is captured on every assistant turn already
// (src/lib/aiCore/memory/persistence.ts) but was never read anywhere
// before this. No $/token pricing exists in any provider response, so
// cost is an estimate from the static table in aiPricing.ts — rows for
// an unpriced model still report real token counts, with their cost
// left null (not silently $0) so the UI can say "unavailable" rather
// than mistake missing pricing for free usage.
async function summarizeAiCosts(windowStart: Date): Promise<OwnerAiCostSummary> {
  const db = await getDb();

  const rows = await db
    .select({
      provider: sql<string>`coalesce(${aiMessages.provider}, 'unknown')`,
      modelId: sql<string>`coalesce(${aiMessages.modelId}, 'unknown')`,
      messageCount: sql<number>`count(*)::int`,
      inputTokens: sql<number>`coalesce(sum((${aiMessages.metadata}->'usage'->>'inputTokens')::int), 0)::int`,
      outputTokens: sql<number>`coalesce(sum((${aiMessages.metadata}->'usage'->>'outputTokens')::int), 0)::int`,
      totalTokens: sql<number>`coalesce(sum((${aiMessages.metadata}->'usage'->>'totalTokens')::int), 0)::int`,
    })
    .from(aiMessages)
    .where(
      and(
        gte(aiMessages.createdAt, windowStart),
        sql`${aiMessages.role} = 'assistant'`
      )
    )
    .groupBy(aiMessages.provider, aiMessages.modelId);

  const [{ count: messagesWithoutUsageData }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(aiMessages)
    .where(
      and(
        gte(aiMessages.createdAt, windowStart),
        sql`${aiMessages.role} = 'assistant'`,
        sql`${aiMessages.metadata}->'usage' is null`
      )
    );

  let totalEstimatedCostUsd = 0;
  let hasRowsWithUnknownPricing = false;

  const costRows: OwnerAiCostRow[] = rows.map((row) => {
    const estimatedCostUsd = estimateCostUsd(
      row.provider === "unknown" ? null : row.provider,
      row.modelId === "unknown" ? null : row.modelId,
      row.inputTokens,
      row.outputTokens
    );
    if (estimatedCostUsd === null) {
      hasRowsWithUnknownPricing = true;
    } else {
      totalEstimatedCostUsd += estimatedCostUsd;
    }
    return { ...row, estimatedCostUsd };
  });

  return {
    rows: costRows,
    totalEstimatedCostUsd,
    hasRowsWithUnknownPricing,
    messagesWithoutUsageData,
  };
}

export async function getOwnerAiCostsToday(): Promise<OwnerAiCostSummary> {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return summarizeAiCosts(startOfToday);
}

export async function getOwnerAiCostsLast30Days(): Promise<OwnerAiCostSummary> {
  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return summarizeAiCosts(windowStart);
}
