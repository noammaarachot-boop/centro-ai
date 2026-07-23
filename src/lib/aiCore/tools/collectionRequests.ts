import { z } from "zod";
import { tool } from "ai";
import {
  getCollectionRequest,
  listCollectionRequests,
  listRequirementsWithDocuments,
  listUnmatchedDocuments,
} from "@/lib/data/collectionRequests";
import { toJsonSafe } from "./jsonSafe";
import type { ToolContext } from "./types";

export function createCollectionRequestTools(ctx: ToolContext) {
  return {
    list_collection_requests: tool({
      description:
        "List this organization's collection requests (document-collection cycles per client), each with its status, period label, client, and service name. Use for questions like 'which requests are active' or 'what's currently waiting on a client'.",
      inputSchema: z.object({}),
      execute: async () => toJsonSafe(await listCollectionRequests(ctx.organizationId)),
    }),
    get_collection_request: tool({
      description:
        "Get full detail for one collection request by id: its document requirements (each with which documents already satisfy it) and any received documents still unmatched to a requirement, needing manual review. Call this after list_collection_requests when the employee asks about one specific request.",
      inputSchema: z.object({ collectionRequestId: z.string().uuid() }),
      execute: async ({ collectionRequestId }) => {
        const request = await getCollectionRequest(ctx.organizationId, collectionRequestId);
        if (!request) return { error: "not_found" as const };
        const [requirements, unmatchedDocuments] = await Promise.all([
          listRequirementsWithDocuments(collectionRequestId),
          listUnmatchedDocuments(collectionRequestId),
        ]);
        return toJsonSafe({ request, requirements, unmatchedDocuments });
      },
    }),
  };
}
