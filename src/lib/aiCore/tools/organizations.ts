import { z } from "zod";
import { tool } from "ai";
import { getOrganization } from "@/lib/data/organizations";
import type { ToolContext } from "./types";

export function createOrganizationTools(ctx: ToolContext) {
  return {
    get_organization_info: tool({
      description:
        "Get this organization's own profile: name, business category, workflow type (recurring vs one-time), business hours, and which integrations (Google Drive, WhatsApp) are connected.",
      inputSchema: z.object({}),
      execute: async () => {
        const organization = await getOrganization(ctx.organizationId);
        return organization ?? { error: "not_found" as const };
      },
    }),
  };
}
