import { OperationFailedError, withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE, GRAPH_API_VERSION } from "./config";
import { parseGraphErrorBody } from "./embeddedSignup";

export class WhatsAppSendError extends Error {}

// Phase 3.2 remediation — thrown only from inside the withRetry callback
// below, for the specific HTTP statuses worth retrying (429 rate-limit,
// 5xx transient server error). Never for other 4xx statuses (invalid
// recipient, unapproved template, bad request) — those fail the exact
// same way on every retry, so retrying them only delays the caller for no
// benefit. Carries the real Response through so the caller can still
// parse/log its body after retries are exhausted.
class RetryableMetaHttpError extends Error {
  constructor(
    message: string,
    public readonly response: Response
  ) {
    super(message);
  }
}

function isRetryableMetaStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// A conservative ceiling under every route's own maxDuration — a hung
// (not merely slow-to-error) Meta request must fail fast enough for
// withRetry to actually get a chance to retry it, rather than silently
// consuming the whole function's time budget (Phase 3.3 remediation).
const META_REQUEST_TIMEOUT_MS = 15_000;

export interface SendResult {
  messageId: string;
}

interface SendMessagesResponse {
  messages?: Array<{ id: string }>;
}

async function postMessage(phoneNumberId: string, payload: Record<string, unknown>): Promise<SendResult> {
  const { systemUserToken } = getWhatsAppConfig();
  // [wa-diag] TEMPORARY — logs endpoint/version/type/status/body only.
  // The access token is NEVER logged. Remove after diagnosis.
  console.log("[wa-diag] postMessage → issuing HTTP request to Meta", {
    endpoint: `${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}/messages`,
    graphVersion: GRAPH_API_VERSION,
    type: payload.type,
    tokenSource: "WHATSAPP_SYSTEM_USER_TOKEN (env / hardcode-off → env)",
  });
  const response = await withRetry(
    async () => {
      const res = await fetch(`${GRAPH_API_BASE}/${encodeURIComponent(phoneNumberId)}/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${systemUserToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(META_REQUEST_TIMEOUT_MS),
      });
      if (isRetryableMetaStatus(res.status)) {
        throw new RetryableMetaHttpError(`Meta returned a retryable status ${res.status}`, res);
      }
      return res;
    },
    {
      // No shouldRetry here on purpose — every way this callback can throw
      // (a network failure, the AbortSignal timeout above, or the explicit
      // RetryableMetaHttpError for 429/5xx) is exactly the set of failures
      // worth retrying; a non-retryable HTTP status (e.g. invalid
      // recipient, unapproved template) never throws from in here at all —
      // it's returned as a normal (non-ok) Response and handled by the
      // caller below, untouched by retry logic, same as before this fix.
      //
      // Meta's own Retry-After header (seconds), when present, takes
      // priority over the default exponential backoff.
      delayMsFor: (error) => {
        if (!(error instanceof RetryableMetaHttpError)) return undefined;
        const retryAfter = error.response.headers.get("retry-after");
        const seconds = retryAfter ? Number(retryAfter) : NaN;
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
      },
    }
  ).catch((error: unknown) => {
    // Retries exhausted on a genuinely retryable status — surface the last
    // real Response so the rest of this function's error handling (body
    // parsing, WhatsAppSendError) stays exactly the same either way,
    // rather than needing a second, divergent error path here.
    if (error instanceof OperationFailedError && error.cause instanceof RetryableMetaHttpError) {
      return error.cause.response;
    }
    throw error;
  });
  if (!response.ok) {
    const body = await response.text();
    // Never log or embed the raw body in an Error message that might get
    // logged downstream — it can echo back request content (recipient
    // number, template parameters, which for the dynamic templates carry
    // the real document list). Only the structured code/message Meta
    // itself returns is worth surfacing, here and in the thrown error's
    // own message (which src/lib/conversationOrchestration.ts's catch
    // block does log in full).
    const parsed = parseGraphErrorBody(body);
    console.error("[wa-diag] Meta response NOT OK", { httpStatus: response.status, code: parsed.code, message: parsed.message });
    throw new WhatsAppSendError(`WhatsApp send failed (${response.status}): code=${parsed.code ?? "?"} message=${parsed.message ?? "(unparseable body)"}`);
  }
  console.log("[wa-diag] Meta response OK", { httpStatus: response.status });
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

export interface InteractiveButton {
  // Echoed back verbatim as message.interactive.button_reply.id on the
  // client's tap (see the webhook route) — never shown to the client,
  // only the title is. Kept short/generic ("confirm_yes"/"confirm_no")
  // since resolveConfirmationFromReply's own "exactly one open
  // confirmation" discipline is what actually disambiguates which
  // question a tap answers, not the button id itself.
  id: string;
  title: string; // WhatsApp hard limit: 20 characters.
}

// WhatsApp Interactive Reply Buttons — real tappable buttons, not typed
// numbers. Same free-form/24h-session-window constraint as sendTextMessage
// (an "interactive" message is not a pre-approved Template): only ever used
// for an "ai" send that's a direct reaction to a message the client just
// sent (see sendOutboundMessage's allowFreeform param). Meta caps this at 3
// buttons per message — callers needing more options (a combined multi-
// group question) fall back to plain numbered text instead; see
// pendingConfirmations.ts's flushDueIntakeNotifications.
export async function sendInteractiveButtonsMessage(
  phoneNumberId: string,
  to: string,
  bodyText: string,
  buttons: InteractiveButton[]
): Promise<SendResult> {
  return postMessage(phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((button) => ({
          type: "reply",
          reply: { id: button.id, title: button.title },
        })),
      },
    },
  });
}

// A body parameter is either positional (fills the template's {{1}},
// {{2}}, ... placeholders in array order — every template Centro has sent
// live so far, e.g. centro_initial_request_v2) or named (fills a
// {{variable_name}}-style placeholder by name, matched via Meta's
// `parameter_name` field regardless of array position — the format
// centro_reminder_v2 was actually created with, {{documents}}). Mixing the
// two within one send isn't meaningful and isn't attempted anywhere in
// this codebase; a caller uses one shape consistently per template.
export type TemplateBodyParam = string | { name: string; value: string };

// Pre-approved Message Template — required for every automated ("ai")
// send, since WhatsApp forbids free-form messages to anyone who hasn't
// messaged the business first (see templates.ts and the WhatsApp plan's
// Message Template constraint).
export async function sendTemplateMessage(
  phoneNumberId: string,
  to: string,
  templateName: string,
  languageCode: string,
  bodyParams: TemplateBodyParam[] = []
): Promise<SendResult> {
  return postMessage(phoneNumberId, {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(bodyParams.length > 0
        ? {
            components: [
              {
                type: "body",
                parameters: bodyParams.map((param) =>
                  typeof param === "string"
                    ? { type: "text", text: param }
                    : { type: "text", parameter_name: param.name, text: param.value }
                ),
              },
            ],
          }
        : {}),
    },
  });
}
