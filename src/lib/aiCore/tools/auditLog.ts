import { z } from "zod";
import { tool } from "ai";
import { listAuditLog } from "@/lib/data/auditLog";
import type { ToolContext } from "./types";

export function createAuditLogTools(ctx: ToolContext) {
  return {
    query_audit_log: tool({
      description:
        "Search this organization's activity history — every significant automated and employee action, chronologically. Optionally filter to one client, one collection request, or a date range. Use for 'what happened with client X' or 'what changed recently' questions.",
      inputSchema: z.object({
        clientId: z.string().uuid().optional(),
        collectionRequestId: z.string().uuid().optional(),
        fromIso: z.string().datetime().optional().describe("ISO 8601 timestamp — only events at or after this time"),
        toIso: z.string().datetime().optional().describe("ISO 8601 timestamp — only events at or before this time"),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      execute: async ({ clientId, collectionRequestId, fromIso, toIso, limit }) =>
        listAuditLog(
          ctx.organizationId,
          {
            clientId,
            collectionRequestId,
            from: fromIso ? new Date(fromIso) : undefined,
            to: toIso ? new Date(toIso) : undefined,
          },
          limit ?? 200
        ),
    }),
  };
}
