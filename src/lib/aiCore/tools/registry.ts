import type { ToolSet } from "ai";
import type { ToolContext } from "./types";
import { createClientTools } from "./clients";
import { createCollectionRequestTools } from "./collectionRequests";
import { createServiceTools } from "./services";
import { createDashboardTools } from "./dashboard";
import { createAuditLogTools } from "./auditLog";
import { createOrganizationTools } from "./organizations";
import { createDriveTools } from "./drive";

// Every tool the copilot may call, assembled fresh per request from the
// acting employee's own session-derived organizationId (see ToolContext)
// — never a module-level singleton, so one organization's tools can
// never leak into another's. This is the one place a new integration
// gets wired in: a new tools/<name>.ts exporting createXTools(ctx), one
// spread entry below, nothing else in the agent loop, prompt, or
// persistence layer changes. Gmail/Calendar/Notion/WhatsApp-send are
// deliberately not here yet — no placeholder tools for integrations that
// don't exist for real.
//
// Every tool today is read-only (get_/list_/query_/search_), so none of
// them call recordAuditEvent (src/lib/audit.ts) — there's nothing to log.
// The first tool whose execute() writes data must call it, same as every
// other mutation path in this codebase (collections/actions.ts, etc.):
//   - actorType: "ai" (already a valid AuditActorType — added with the
//     rest of the enum for exactly this future case)
//   - actorUserId: ctx.actingUserId — the employee who drove the turn,
//     not a synthetic "AI" user, so the log reads like every other
//     employee-attributed action
//   - eventType/description: describe the actual mutation (e.g.
//     "collection_request.status_changed"), not "ai.tool_called" — the
//     audit log is a record of what happened, not of how it happened
//   - call it from inside the tool's own execute(), after the mutation
//     succeeds, exactly where the equivalent Server Action would call it
export function buildToolRegistry(ctx: ToolContext): ToolSet {
  return {
    ...createClientTools(ctx),
    ...createCollectionRequestTools(ctx),
    ...createServiceTools(ctx),
    ...createDashboardTools(ctx),
    ...createAuditLogTools(ctx),
    ...createOrganizationTools(ctx),
    ...createDriveTools(ctx),
  };
}
