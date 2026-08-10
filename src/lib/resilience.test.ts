import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationFailedError, withRetry } from "./resilience";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("withRetry — default behavior (no options — every existing caller)", () => {
  it("returns the result immediately on first success, never sleeps", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    await expect(withRetry(operation)).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries on any thrown error, with exponential backoff, up to the default 3 attempts", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("fail 1")).mockRejectedValueOnce(new Error("fail 2")).mockResolvedValueOnce("ok");
    const promise = withRetry(operation);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("throws OperationFailedError, with the real last error as .cause, once every attempt is exhausted", async () => {
    const lastError = new Error("always fails");
    const operation = vi.fn().mockRejectedValue(lastError);
    const promise = withRetry(operation, { attempts: 2, baseDelayMs: 10 });
    const assertion = expect(promise).rejects.toBeInstanceOf(OperationFailedError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("withRetry — shouldRetry (Phase 3.2)", () => {
  it("stops immediately (rethrows the original error, unwrapped) when shouldRetry returns false — never sleeps, never retries", async () => {
    class NonRetryable extends Error {}
    const operation = vi.fn().mockRejectedValue(new NonRetryable("won't ever succeed"));
    await expect(withRetry(operation, { shouldRetry: () => false })).rejects.toBeInstanceOf(NonRetryable);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying when shouldRetry returns true", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");
    const promise = withRetry(operation, { shouldRetry: () => true, baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });
});

describe("withRetry — delayMsFor (Phase 3.2, honoring a server's Retry-After)", () => {
  it("uses the delay delayMsFor returns instead of the default exponential backoff", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce("ok");
    const delayMsFor = vi.fn().mockReturnValue(5_000);
    const promise = withRetry(operation, { delayMsFor, baseDelayMs: 10 });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(operation).toHaveBeenCalledTimes(1); // not yet — still waiting on the 5s delay, not the 10ms default

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("falls back to the default exponential backoff when delayMsFor returns undefined", async () => {
    const operation = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");
    const promise = withRetry(operation, { delayMsFor: () => undefined, baseDelayMs: 10 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe("ok");
  });
});
