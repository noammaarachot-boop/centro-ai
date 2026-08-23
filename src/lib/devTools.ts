import { notFound } from "next/navigation";

// Development-only surfaces (DevToolsPanel and the actions behind it).
//
// These are real, working controls — "run the scheduler now" genuinely
// sends WhatsApp messages to real clients, and the inbound-message
// simulator genuinely creates documents and runs classification. They are
// pilot-stage tooling that predates having real customers; with real
// tenants on the platform they must not be reachable from the product at
// all.
//
// One predicate, used in two places for every tool:
//   • the page decides whether to RENDER it, and
//   • the server action itself refuses to RUN in production.
//
// The second is the one that actually matters. Hiding the UI alone would
// leave every action reachable — a Server Action is an HTTP endpoint whose
// id is discoverable from the client bundle, so "not rendered" is not
// "not callable".
// Fail-CLOSED by construction: an explicit allowlist of the only two
// environments these tools may ever appear in.
//
// The obvious form — NODE_ENV !== "production" — fails OPEN: an unset,
// empty, mis-cased ("Production") or otherwise unexpected value all read
// as "not production" and would unlock every tool. Next.js does set
// NODE_ENV correctly for `next build`/`next start`, but a safety boundary
// must not depend on the framework behaving as expected; anything not on
// this list stays blocked.
const DEV_TOOL_ENVIRONMENTS = ["development", "test"] as const;

export function devToolsEnabled(): boolean {
  const environment = process.env.NODE_ENV;
  return DEV_TOOL_ENVIRONMENTS.some((allowed) => allowed === environment);
}

/**
 * Server-side gate for a development-only action or route. Call FIRST,
 * before reading input or touching the database.
 *
 * Uses notFound() rather than a 403 so a production deployment reveals
 * nothing about the existence of these endpoints.
 */
export function assertDevToolsEnabled(): void {
  if (!devToolsEnabled()) {
    notFound();
  }
}
