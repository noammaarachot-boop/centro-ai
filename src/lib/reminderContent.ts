import { isWithinFreeformSessionWindow, type TemplateSend } from "@/lib/conversationOrchestration";
import { listMissingRequirementNames } from "@/lib/caseReview";
import { formatRequirementListForTemplateParam } from "@/lib/documentRequestList";
import { REMINDER_BODY, REMINDER_V2_BODY, REMINDER_V2_ENABLED, REMINDER_V2_TEMPLATE_NAME } from "@/lib/whatsapp/templates";

/**
 * Dynamic reminder content — instead of a static "still waiting for your
 * answer," the reminder names exactly which documents are still missing
 * (and only those — never a document that already arrived and was
 * approved). Two delivery paths, matching WhatsApp's own 24-hour customer
 * service session window:
 *
 *   - Window open (the client messaged within the last 24h): free-form
 *     text can say exactly this, naturally.
 *   - Window closed: only a pre-approved Template may be sent at all — the
 *     dynamic centro_reminder_v2 Template once approved on the WABA
 *     (REMINDER_V2_ENABLED), or today's static centro_reminder Template as
 *     the safe fallback until then. Never silently fails: sendOutboundMessage's
 *     own template resolution surfaces a clear "no_template"/delivery
 *     failure if it can't send, rather than losing the reminder silently.
 */

export interface ReminderSend {
  body: string;
  templateSend?: TemplateSend;
  allowFreeform: boolean;
}

// v2Enabled is injectable (same pattern as buildInitialRequestSend's own
// v2Enabled parameter) so the Template-selection branch stays independently
// unit-testable regardless of the live REMINDER_V2_ENABLED flag — real
// callers never pass it and get today's live flag value.
export async function buildReminderSend(
  conversationId: string,
  collectionRequestId: string,
  clientName: string,
  v2Enabled: boolean = REMINDER_V2_ENABLED
): Promise<ReminderSend> {
  const missing = await listMissingRequirementNames(collectionRequestId);
  if (missing.length === 0) {
    // Shouldn't normally be reached — the scheduler already checks
    // checkCompletionGate before ever calling this — but never invents a
    // missing-document list when there genuinely isn't one.
    return { body: REMINDER_BODY, allowFreeform: false };
  }

  const withinWindow = await isWithinFreeformSessionWindow(conversationId);
  const missingList = missing.join(", ");

  if (withinWindow) {
    return {
      body: `היי ${clientName}, רק תזכורת קטנה — עדיין חסרים לנו: ${missingList}. אפשר לשלוח אותם כאן. תודה!`,
      allowFreeform: true,
    };
  }

  if (v2Enabled) {
    const listParam = formatRequirementListForTemplateParam(missing);
    return {
      body: REMINDER_V2_BODY.replace("{{1}}", clientName).replace("{{2}}", listParam),
      templateSend: { templateName: REMINDER_V2_TEMPLATE_NAME, language: "he", params: [clientName, listParam] },
      allowFreeform: false,
    };
  }

  // Fallback until centro_reminder_v2 is approved on the WABA — today's
  // exact behavior, unchanged.
  return { body: REMINDER_BODY, allowFreeform: false };
}
