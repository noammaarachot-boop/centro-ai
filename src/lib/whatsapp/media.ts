import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppMediaError extends Error {}

// Phase 7 remediation — this module runs on the inbound WhatsApp webhook's
// hot path (a client's attachment), inside a route whose own maxDuration is
// 180s (src/app/api/webhooks/whatsapp/route.ts) — a hung Graph API call
// here previously had no bound of its own and could quietly consume a large
// share of that budget. Metadata lookup mirrors send.ts's 15s Meta-call
// convention; the actual file transfer gets the longer allowance
// googleAuth/drive.ts already uses for its own file transfers (30s), since
// a real attachment can be larger than a metadata response.
const WHATSAPP_MEDIA_METADATA_TIMEOUT_MS = 15_000;
const WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

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
      signal: AbortSignal.timeout(WHATSAPP_MEDIA_METADATA_TIMEOUT_MS),
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
    fetch(meta.url!, {
      headers: { Authorization: `Bearer ${systemUserToken}` },
      signal: AbortSignal.timeout(WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS),
    })
  );
  if (!fileResponse.ok) {
    throw new WhatsAppMediaError(`Media download failed (${fileResponse.status})`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  return { bytes: Buffer.from(arrayBuffer), mimeType: meta.mime_type ?? "application/octet-stream" };
}
