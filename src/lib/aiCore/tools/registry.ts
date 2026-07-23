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
