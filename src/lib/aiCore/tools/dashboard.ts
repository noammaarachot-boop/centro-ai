import { z } from "zod";
import { tool } from "ai";
import {
  getDashboardCounts,
  listBusinessTypeSuggestions,
  listPendingConfirmationsForDashboard,
  listQueue,
  type DashboardQueue,
} from "@/lib/data/dashboard";
import { toJsonSafe } from "./jsonSafe";
import type { ToolContext } from "./types";

const QUEUE_VALUES = [
  "active",
  "waiting_for_client",
  "needs_review",
  "processing_documents",
  "completed_today",
  "business_type_suggestions",
  "pending_confirmations",
] as const satisfies readonly DashboardQueue[];

// listQueue (src/lib/data/dashboard.ts) only actually handles five of the
// seven DashboardQueue values itself — "business_type_suggestions" and
// "pending_confirmations" are client-shaped, not collection-request-
// shaped, and have their own dedicated functions. This dispatch hides
// that split behind one clean tool matching the enum's own semantics,
// rather than exposing the underlying API's shape mismatch to the model.
async function fetchQueue(organizationId: string, queue: DashboardQueue) {
  if (queue === "business_type_suggestions") return listBusinessTypeSuggestions(organizationId);
  if (queue === "pending_confirmations") return listPendingConfirmationsForDashboard(organizationId);
  return listQueue(organizationId, queue);
}

export function createDashboardTools(ctx: ToolContext) {
  return {
    get_dashboard_counts: tool({
      description:
        "Get the organization's dashboard summary counts: active/waiting-for-client/needs-review/processing/completed-today collection requests, plus counts of clients needing a business-type suggestion reviewed and open client confirmations. Good first call for a broad 'what needs my attention' question.",
      inputSchema: z.object({}),
      execute: async () => toJsonSafe(await getDashboardCounts(ctx.organizationId)),
    }),
    list_dashboard_queue: tool({
      description:
        "List the actual items behind one of the dashboard's summary counts (from get_dashboard_counts). Use after get_dashboard_counts to see specifics, e.g. which collection requests are waiting_for_client.",
      inputSchema: z.object({ queue: z.enum(QUEUE_VALUES) }),
      execute: async ({ queue }) => toJsonSafe(await fetchQueue(ctx.organizationId, queue)),
    }),
  };
}
