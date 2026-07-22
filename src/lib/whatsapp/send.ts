import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppSendError extends Error {}

export interface SendResult {
  messageId: string;
}

interface SendMessagesResponse {
  messages?: Array<{ id: string }>;
}

async function postMessage(phoneNumberId: string, payload: Record<string, unknown>): Promise<SendResult> {
  const { systemUserToken } = getWhatsAppConfig();
  const response = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${systemUserToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    })
  );
  if (!response.ok) {
    const body = await response.text();
    throw new WhatsAppSendError(`WhatsApp send failed (${response.status}): ${body}`);
  }
  const data = (await response.json()) as SendMessagesResponse;
  const messageId = data.messages?.[0]?.id;
  if (!messageId) throw new WhatsAppSendError("WhatsApp send returned no message id");
  return { messageId };
}

// Free-form text — WhatsApp only permits this within the 24-hour
// customer service window (the recipient messaged first, recently).
// Used only for human ("employee") sends in sendOutboundMessage, which
// only ever happen inside an already-open conversation with the client.
export async function sendTextMessage(phoneNumberId: string, to: string, body: string): Promise<SendResult> {
  return postMessage(phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body },
  });
}

// Pre-approved Message Template — required for every automated ("ai")
// send, since WhatsApp forbids free-form messages to anyone who hasn't
// messaged the business first (see templates.ts and the WhatsApp plan's
// Message Template constraint). `bodyParams` fill the template's {{1}},
// {{2}}, ... placeholders in order; none of Centro's four templates use
// any today, so callers pass an empty array.
export async function sendTemplateMessage(
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: string[] = []
): Promise<SendResult> {
  return postMessage(phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0
        ? { components: [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }] }
        : {}),
    },
  });
}
