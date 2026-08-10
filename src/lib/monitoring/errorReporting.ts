import * as Sentry from "@sentry/node";

/**
 * Phase 6.1 (Production Hardening) — structured error monitoring. Every
 * outbound integration failure Centro already logs to the console
 * (webhook processing, the cron tick, an exhausted retry) is currently
 * only ever seen by whoever happens to be tailing Vercel's logs at the
 * right moment; nothing pages anyone or aggregates recurring failures.
 * This wraps Sentry (SENTRY_DSN, Vercel env — never hardcoded, never set
 * here) as thin, optional infrastructure: capture calls at the three
 * places the audit named (webhook route, cron tick route, withRetry's
 * exhaustion path) — never a required dependency of the request path
 * itself. With no SENTRY_DSN configured (true until a human explicitly
 * sets it in Vercel), this module is a complete no-op: no network call,
 * no thrown error, no behavior change to anything it's called from.
 */

let initState: "uninitialized" | "enabled" | "disabled" = "uninitialized";

function ensureInitialized(): boolean {
  if (initState === "uninitialized") {
    const dsn = process.env.SENTRY_DSN;
    if (dsn) {
      Sentry.init({
        dsn,
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
        // Error capture only — no performance tracing. Nothing in the
        // audit/plan asked for request tracing, and enabling it would add
        // overhead and cost with no named use case behind it.
        tracesSampleRate: 0,
      });
      initState = "enabled";
    } else {
      initState = "disabled";
    }
  }
  return initState === "enabled";
}

// Never throws — a monitoring failure (network issue reaching Sentry, a
// bad DSN, anything) must never be allowed to become a second, unrelated
// failure on top of the real one this is trying to report.
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  try {
    if (!ensureInitialized()) return;
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch (reportingError) {
    console.error("[monitoring] error reporting itself failed", reportingError);
  }
}
