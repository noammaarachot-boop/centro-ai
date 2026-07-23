import { z } from "zod";
import { tool } from "ai";
import { getOrganization } from "@/lib/data/organizations";
import { getValidAccessToken, GoogleNotConnectedError } from "@/lib/googleAuth/driveTokens";
import { DriveApiError, getDriveFile, getDriveFolder } from "@/lib/googleAuth/drive";
import type { ToolContext } from "./types";

// A Drive hiccup (not connected, expired grant, file trashed) must never
// abort the whole agent turn — mirrors sendViaWhatsApp's degrade-
// gracefully pattern (conversationOrchestration.ts): return a structured,
// explainable result instead of throwing.
export function createDriveTools(ctx: ToolContext) {
  return {
    get_drive_folder_info: tool({
      description:
        "Look up this organization's connected Google Drive root folder. Use for 'is Drive connected' or 'what folder are we storing documents in'. Returns connected:false (not an error) if Drive isn't set up — report that plainly to the employee.",
      inputSchema: z.object({}),
      execute: async () => {
        const organization = await getOrganization(ctx.organizationId);
        if (!organization?.googleDriveFolderId) return { connected: false as const };
        try {
          const accessToken = await getValidAccessToken(ctx.organizationId);
          const folder = await getDriveFolder(accessToken, organization.googleDriveFolderId);
          return { connected: true as const, folder };
        } catch (error) {
          if (error instanceof GoogleNotConnectedError || error instanceof DriveApiError) {
            return { connected: false as const, error: error.message };
          }
          throw error;
        }
      },
    }),
    get_drive_file_info: tool({
      description:
        "Look up one Google Drive file by its Drive file id (e.g. a document's googleDriveFileId, from get_collection_request's returned documents) — its name and a viewable link, or found:false if it's missing or was deleted from Drive.",
      inputSchema: z.object({ driveFileId: z.string().min(1) }),
      execute: async ({ driveFileId }) => {
        try {
          const accessToken = await getValidAccessToken(ctx.organizationId);
          const file = await getDriveFile(accessToken, driveFileId);
          return { found: true as const, file };
        } catch (error) {
          if (error instanceof GoogleNotConnectedError || error instanceof DriveApiError) {
            return { found: false as const, error: error.message };
          }
          throw error;
        }
      },
    }),
  };
}
