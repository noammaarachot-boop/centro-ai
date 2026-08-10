import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Phase 6.1 — captureError must be a true no-op with no SENTRY_DSN
// configured (the default everywhere until a human explicitly sets it in
// Vercel), forward real errors to Sentry once it is, and never itself
// throw regardless of what Sentry's SDK does. initState is cached at
// module scope (lazy, once-only init), so every test resets the module
// registry and re-imports fresh to get an independent instance.

const init = vi.fn();
const captureException = vi.fn();
vi.mock("@sentry/node", () => ({ init: (...args: unknown[]) => init(...args), captureException: (...args: unknown[]) => captureException(...args) }));

const ORIGINAL_DSN = process.env.SENTRY_DSN;

beforeEach(() => {
  vi.resetModules();
  init.mockReset();
  captureException.mockReset();
});

afterEach(() => {
  if (ORIGINAL_DSN === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = ORIGINAL_DSN;
});

describe("captureError — no SENTRY_DSN configured", () => {
  it("is a complete no-op: never initializes Sentry, never reports, never throws", async () => {
    delete process.env.SENTRY_DSN;
    const { captureError } = await import("./errorReporting");

    expect(() => captureError(new Error("boom"))).not.toThrow();

    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("captureError — SENTRY_DSN configured", () => {
  it("initializes Sentry once (lazily) and forwards the error with extra context", async () => {
    process.env.SENTRY_DSN = "https://fake@example.ingest.sentry.io/1";
    const { captureError } = await import("./errorReporting");
    const error = new Error("real failure");

    captureError(error, { jobName: "cron.tick" });

    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ dsn: "https://fake@example.ingest.sentry.io/1" }));
    expect(captureException).toHaveBeenCalledWith(error, { extra: { jobName: "cron.tick" } });

    captureError(new Error("second failure"));
    expect(init).toHaveBeenCalledTimes(1); // still lazily-once, not re-initialized per call
  });

  it("never throws even when Sentry.captureException itself fails", async () => {
    process.env.SENTRY_DSN = "https://fake@example.ingest.sentry.io/1";
    captureException.mockImplementation(() => {
      throw new Error("Sentry SDK internal failure");
    });
    const { captureError } = await import("./errorReporting");

    expect(() => captureError(new Error("boom"))).not.toThrow();
  });
});
