import { getDb } from "@/db";
import { aiUsageEvents } from "@/db/schema";

/**
 * The one writer of ai_usage_events.
 *
 * Never throws. Telemetry exists to explain a bill; it is not worth failing a
 * client's document classification over, and a cost table that can break the
 * product is a worse problem than no cost table. Every failure here is
 * swallowed after a log line — the caller (the middleware) has already
 * returned the provider's real result by the time this runs.
 */
export interface AiUsageEvent {
  organizationId?: string | null;
  operation: string;
  provider: string;
  modelId: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteTokens?: number | null;
  reasoningTokens?: number | null;
  latencyMs: number;
  success: boolean;
  errorKind?: string | null;
  attempt: number;
  environment: string;
  collectionRequestId?: string | null;
  conversationId?: string | null;
  documentId?: string | null;
}

export async function recordAiUsage(event: AiUsageEvent): Promise<void> {
  try {
    const db = await getDb();
    await db.insert(aiUsageEvents).values({
      organizationId: event.organizationId ?? null,
      operation: event.operation,
      provider: event.provider,
      modelId: event.modelId,
      inputTokens: event.inputTokens ?? null,
      outputTokens: event.outputTokens ?? null,
      totalTokens: event.totalTokens ?? null,
      cachedInputTokens: event.cachedInputTokens ?? null,
      cacheWriteTokens: event.cacheWriteTokens ?? null,
      reasoningTokens: event.reasoningTokens ?? null,
      latencyMs: event.latencyMs,
      success: event.success,
      errorKind: event.errorKind ?? null,
      attempt: event.attempt,
      environment: event.environment,
      collectionRequestId: event.collectionRequestId ?? null,
      conversationId: event.conversationId ?? null,
      documentId: event.documentId ?? null,
    });
  } catch (error) {
    // Deliberately console, not captureError: a monitoring failure that
    // reports itself through monitoring can loop, and this path may be
    // running inside a request that is already failing.
    console.error("[ai-telemetry] failed to record usage", {
      operation: event.operation,
      provider: event.provider,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * A short, safe label for a failure.
 *
 * Never the provider's message. A rejected request is exactly the kind of
 * error that quotes the payload back, and a payload here is a client's
 * document or conversation — content that must not end up in a cost table
 * because someone wanted better debugging. The constructor name separates a
 * rate limit from a schema failure, which is what this column is for.
 */
export function classifyErrorKind(error: unknown): string {
  if (error instanceof Error) {
    const name = error.constructor?.name ?? error.name;
    return typeof name === "string" && name.length > 0 ? name.slice(0, 64) : "Error";
  }
  return "UnknownError";
}

/**
 * Which deployment is spending the money.
 *
 * VERCEL_ENV is production/preview/development on Vercel and absent
 * elsewhere, where NODE_ENV is the honest answer. This matters because the
 * same API key was found in the production environment AND in a local
 * .env.local: whether local work spends the production budget should be a
 * query against real rows, not an assumption either way.
 */
export function currentEnvironment(): string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown";
}
