import { captureError } from "@/lib/monitoring/errorReporting";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  // Phase 3.2 remediation — checked before deciding to retry a caught
  // error. Return false to stop immediately: the error is rethrown as-is
  // (never wrapped in OperationFailedError, never delayed) — for a class
  // of failure that will never succeed on retry (e.g. an HTTP 4xx that
  // isn't a rate limit). Omitted entirely (the default): every caller that
  // doesn't pass this keeps today's exact behavior — retry on any thrown
  // error.
  shouldRetry?: (error: unknown) => boolean;
  // Overrides the default exponential-backoff delay for the NEXT attempt,
  // given the error that just occurred and the 1-based attempt number that
  // just failed. Return undefined to fall back to the default backoff.
  // Exists so a caller can honor a server's own Retry-After response
  // header instead of guessing a delay.
  delayMsFor?: (error: unknown, attempt: number) => number | undefined;
}

export class OperationFailedError extends Error {
  constructor(
    message: string,
    public readonly cause: unknown
  ) {
    super(message);
  }
}

// FR-15.1/FR-15.2 (Ch.15): integration failures are detected and
// recoverable operations retried automatically, with exponential backoff,
// before ever being surfaced as a failure. Wraps any integration call —
// Drive upload, WhatsApp send — so a transient failure doesn't
// immediately propagate into the caller. BR-15.1: a failure here must
// never be allowed to corrupt or close a Collection Request; callers
// catch OperationFailedError and degrade gracefully (see
// src/lib/storage/driveAdapter.ts) rather than letting it bubble into a
// crashed server action.
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 200;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (options.shouldRetry && !options.shouldRetry(error)) {
        throw error;
      }
      if (attempt < attempts) {
        const delay = options.delayMsFor?.(error, attempt) ?? baseDelayMs * 2 ** (attempt - 1);
        await new Promise((resolve) =>
          setTimeout(resolve, delay)
        );
      }
    }
  }
  // Phase 6.1 — every retry budget genuinely exhausted (not a
  // shouldRetry-declined immediate failure, which rethrows above before
  // ever reaching here) is exactly the class of integration failure that
  // should page someone, not just scroll past in the logs.
  captureError(lastError, { attempts });
  throw new OperationFailedError(
    `Operation failed after ${attempts} attempts`,
    lastError
  );
}
