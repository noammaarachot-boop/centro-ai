import type { LanguageModelMiddleware } from "ai";
import { getAiCallContext } from "./context";
import { classifyErrorKind, currentEnvironment, recordAiUsage } from "./record";

/**
 * Records every provider call, from inside the model itself.
 *
 * This is why there is one implementation instead of twelve. The alternative
 * — a helper each call site remembers to use — is a convention, and a
 * convention is exactly what produced the situation this fixes: the assistant
 * recorded its tokens and the twelve classifiers recorded nothing, because
 * nothing forced them to. Here the model handed to a caller is already
 * instrumented, so a call site cannot opt out and a NEW call site cannot
 * forget.
 *
 * It also sees what a call-site wrapper structurally cannot: the SDK retries
 * by invoking the model again, so each attempt reaches this middleware
 * separately and is billed separately. Measuring at the call site would
 * report one call where the provider charged for three.
 */
export function usageRecordingMiddleware(
  provider: string,
  modelId: string
): LanguageModelMiddleware {
  return {
    wrapGenerate: async ({ doGenerate }) => {
      const startedAt = Date.now();
      const context = getAiCallContext();
      const attempt = nextAttempt(context?.attemptCounter);

      try {
        const result = await doGenerate();
        await record({ provider, modelId, context, attempt, startedAt, usage: result.usage });
        return result;
      } catch (error) {
        await record({
          provider,
          modelId,
          context,
          attempt,
          startedAt,
          errorKind: classifyErrorKind(error),
        });
        // The provider's failure is the caller's to handle, unchanged.
        throw error;
      }
    },

    wrapStream: async ({ doStream }) => {
      const startedAt = Date.now();
      const context = getAiCallContext();
      const attempt = nextAttempt(context?.attemptCounter);

      let stream;
      try {
        stream = await doStream();
      } catch (error) {
        await record({
          provider,
          modelId,
          context,
          attempt,
          startedAt,
          errorKind: classifyErrorKind(error),
        });
        throw error;
      }

      // A stream reports its usage in the final part, so the row cannot be
      // written until the consumer has finished reading. Writing it at
      // subscribe time instead would record every streamed answer as having
      // cost nothing.
      let usage: ProviderUsage | undefined;
      const measured = stream.stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk.type === "finish") usage = chunk.usage as ProviderUsage;
            controller.enqueue(chunk);
          },
          flush() {
            // Not awaited: flush must not hold the response open, and the
            // recorder never throws.
            void record({ provider, modelId, context, attempt, startedAt, usage });
          },
        })
      );

      return { ...stream, stream: measured };
    },
  };
}

/**
 * The provider's usage, reduced to the numbers a bill is made of.
 *
 * The SDK reports input and output as structured objects — input split into
 * fresh, cache-read and cache-write, output split into text and reasoning —
 * because providers price those differently. That detail is kept rather than
 * flattened: cache reads cost a fraction of fresh input and cache writes cost
 * a premium, so a single "input tokens" number cannot be priced correctly.
 *
 * Every field stays optional, and a missing one is recorded as null rather
 * than zero. Zero claims a call was free, which is a different statement from
 * "the provider did not tell us".
 */
interface ProviderUsage {
  inputTokens?: { total?: number; noCache?: number; cacheRead?: number; cacheWrite?: number };
  outputTokens?: { total?: number; text?: number; reasoning?: number };
  totalTokens?: number;
}

interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

const EMPTY_USAGE: NormalizedUsage = {
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  cachedInputTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
};

function normalizeUsage(usage: ProviderUsage | undefined): NormalizedUsage {
  if (!usage) return EMPTY_USAGE;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const inputTotal = input?.total ?? null;
  const outputTotal = output?.total ?? null;
  return {
    inputTokens: inputTotal,
    outputTokens: outputTotal,
    // Only a real sum, never a half-known one presented as a total.
    totalTokens:
      usage.totalTokens ??
      (inputTotal !== null && outputTotal !== null ? inputTotal + outputTotal : null),
    cachedInputTokens: input?.cacheRead ?? null,
    cacheWriteTokens: input?.cacheWrite ?? null,
    reasoningTokens: output?.reasoning ?? null,
  };
}

function nextAttempt(counter: { count: number } | undefined): number {
  if (!counter) return 1;
  counter.count += 1;
  return counter.count;
}

async function record(input: {
  provider: string;
  modelId: string;
  context: ReturnType<typeof getAiCallContext>;
  attempt: number;
  startedAt: number;
  usage?: ProviderUsage;
  errorKind?: string;
}): Promise<void> {
  const { provider, modelId, context, attempt, startedAt, usage, errorKind } = input;
  await recordAiUsage({
    organizationId: context?.organizationId ?? null,
    // An unnamed operation is a real gap, not a default to hide behind: it
    // means some path reached the provider without declaring what it was
    // doing, and it should be findable by querying for exactly this value.
    operation: context?.operation ?? "unattributed",
    provider,
    modelId,
    ...normalizeUsage(usage),
    latencyMs: Date.now() - startedAt,
    success: errorKind === undefined,
    errorKind: errorKind ?? null,
    attempt,
    environment: currentEnvironment(),
    collectionRequestId: context?.collectionRequestId ?? null,
    conversationId: context?.conversationId ?? null,
    documentId: context?.documentId ?? null,
  });
}
