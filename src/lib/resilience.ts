export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
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
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1))
        );
      }
    }
  }
  throw new OperationFailedError(
    `Operation failed after ${attempts} attempts`,
    lastError
  );
}
