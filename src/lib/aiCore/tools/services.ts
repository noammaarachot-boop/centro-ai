import { z } from "zod";
import { tool } from "ai";
import { getService, listServiceClients, listServiceRequirements, listServices } from "@/lib/data/services";
import type { ToolContext } from "./types";

export function createServiceTools(ctx: ToolContext) {
  return {
    list_services: tool({
      description:
        "List every service/template this organization offers (a service defines a set of required documents for a recurring or one-time collection cycle).",
      inputSchema: z.object({}),
      execute: async () => listServices(ctx.organizationId),
    }),
    get_service: tool({
      description: "Get one service by id, including its document requirements and which clients are assigned to it.",
      inputSchema: z.object({ serviceId: z.string().uuid() }),
      execute: async ({ serviceId }) => {
        const service = await getService(ctx.organizationId, serviceId);
        if (!service) return { error: "not_found" as const };
        const [requirements, clients] = await Promise.all([
          listServiceRequirements(serviceId),
          listServiceClients(ctx.organizationId, serviceId),
        ]);
        return { service, requirements, clients };
      },
    }),
  };
}
