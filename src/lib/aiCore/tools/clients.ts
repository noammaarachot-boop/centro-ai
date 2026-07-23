import { z } from "zod";
import { tool } from "ai";
import { getClient, listClientServices, listClients } from "@/lib/data/clients";
import { searchClients } from "@/lib/data/dashboard";
import type { ToolContext } from "./types";

export function createClientTools(ctx: ToolContext) {
  return {
    list_clients: tool({
      description:
        "List every client in this organization. Use for broad questions like 'how many clients do I have' or 'list my clients'. For a specific client by name, prefer search_clients instead.",
      inputSchema: z.object({}),
      execute: async () => listClients(ctx.organizationId),
    }),
    search_clients: tool({
      description:
        "Search clients by name or phone number (partial match). Use this when the employee names a specific client rather than asking for the full list.",
      inputSchema: z.object({ query: z.string().min(1).describe("Part of a client's name or phone number") }),
      execute: async ({ query }) => searchClients(ctx.organizationId, query),
    }),
    get_client: tool({
      description: "Get full detail for one client by id, including business type and classification confidence.",
      inputSchema: z.object({ clientId: z.string().uuid() }),
      execute: async ({ clientId }) => {
        const client = await getClient(ctx.organizationId, clientId);
        return client ?? { error: "not_found" as const };
      },
    }),
    list_client_services: tool({
      description: "List the services/templates a specific client is assigned to.",
      inputSchema: z.object({ clientId: z.string().uuid() }),
      execute: async ({ clientId }) => listClientServices(ctx.organizationId, clientId),
    }),
  };
}
