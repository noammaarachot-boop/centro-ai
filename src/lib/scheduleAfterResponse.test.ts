import { describe, expect, it, vi } from "vitest";

describe("scheduleAfterResponse", () => {
  it("never throws even when called outside a request scope (e.g. every test in this codebase)", async () => {
    const { scheduleAfterResponse } = await import("./scheduleAfterResponse");
    const task = vi.fn();
    // next/server's after() throws "called outside a request scope" here —
    // this is exactly that situation, and the whole point of the wrapper
    // is that it must not propagate.
    expect(() => scheduleAfterResponse(task)).not.toThrow();
    // The task itself is never invoked in that case — there's no request
    // lifetime for Next to run it against.
    expect(task).not.toHaveBeenCalled();
  });
});
