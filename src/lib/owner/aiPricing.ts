// Static, manually-maintained $/1M-token pricing for the Owner
// Dashboard's AI cost estimate. No provider SDK or API returns price —
// only token counts — so this table is the one piece of the cost
// calculation that has to be kept in sync by hand as provider pricing
// changes. Update these to match actual current provider pricing; treat
// every figure here as an estimate, not a billing-grade number.
//
// Keyed by (provider, modelId) exactly as stored on aiMessages.provider/
// modelId — see src/lib/aiCore/config.ts's DEFAULT_MODELS for what a
// fresh install actually uses. A model not listed here still shows its
// real token counts; its cost is reported as "unavailable" rather than
// silently computed as $0 (see costs.ts).
export interface ModelPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

const PRICING_TABLE: Record<string, Record<string, ModelPricing>> = {
  openai: {
    "gpt-4o": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 },
    "gpt-4o-mini": { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 },
  },
  anthropic: {
    "claude-sonnet-5": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
    "claude-opus-4-8": { inputPerMillionUsd: 15, outputPerMillionUsd: 75 },
    "claude-haiku-4-5": { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 },
  },
  google: {
    "gemini-2.0-flash": { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4 },
  },
};

export function getModelPricing(provider: string | null, modelId: string | null): ModelPricing | null {
  if (!provider || !modelId) return null;
  return PRICING_TABLE[provider]?.[modelId] ?? null;
}

export function estimateCostUsd(
  provider: string | null,
  modelId: string | null,
  inputTokens: number,
  outputTokens: number
): number | null {
  const pricing = getModelPricing(provider, modelId);
  if (!pricing) return null;
  return (
    (inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
    (outputTokens / 1_000_000) * pricing.outputPerMillionUsd
  );
}
