import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppMediaError extends Error {}

export interface DownloadedMedia {
  bytes: Buffer;
  mimeType: string;
}

// Inbound media never arrives as bytes in the webhook payload itself —
// only a media id. Retrieving the real file is a two-step Graph API
// call: resolve a short-lived download URL, then fetch it, with the
// same bearer token required on both requests (the URL alone isn't
// enough to authorize the download).
export async function downloadMedia(mediaId: string): Promise<DownloadedMedia> {
  const { systemUserToken } = getWhatsAppConfig();

  const metaResponse = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(mediaId)}`, {
      headers: { Authorization: `Bearer ${systemUserToken}` },
    })
  );
  if (!metaResponse.ok) {
    throw new WhatsAppMediaError(`Media lookup failed (${metaResponse.status})`);
  }
  const meta = (await metaResponse.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new WhatsAppMediaError("Media lookup returned no download URL");
  }

  const fileResponse = await withRetry(() =>
    fetch(meta.url!, { headers: { Authorization: `Bearer ${systemUserToken}` } })
  );
  if (!fileResponse.ok) {
    throw new WhatsAppMediaError(`Media download failed (${fileResponse.status})`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  return { bytes: Buffer.from(arrayBuffer), mimeType: meta.mime_type ?? "application/octet-stream" };
}
