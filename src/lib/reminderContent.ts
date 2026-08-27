import { isWithinFreeformSessionWindow, type TemplateSend } from "@/lib/conversationOrchestration";
import { listMissingRequirementNames } from "@/lib/caseReview";
import { formatRequirementListForTemplateParam } from "@/lib/documentRequestList";
import {
  buildTemplateParams,
  renderTemplateBody,
  resolveApprovedTemplate,
} from "@/lib/whatsapp/organizationWhatsApp";

/**
 * Dynamic reminder content — instead of a static "still waiting for your
 * answer," the reminder names exactly which documents are still missing
 * (and only those — never a document that already arrived and was
 * approved). Two delivery paths, matching WhatsApp's own 24-hour customer
 * service session window:
 *
 *   - Window open (the client messaged within the last 24h): free-form
 *     text can say exactly this, naturally.
 *   - Window closed: only a template THIS organization has approved on its
 *     own WABA may be sent, resolved by intent. There is deliberately no
 *     fallback to another template — the old code fell back to the static
 *     centro_reminder, which is just as absent from a given office's WABA as
 *     the template that failed, turning a diagnosable configuration problem
 *     into a second identical Meta rejection.
 */

export interface ReminderSend {
  body: string;
  templateSend?: TemplateSend;
  allowFreeform: boolean;
  /**
   * Set when no send is possible. The caller reports this instead of
   * sending — it never substitutes a different template.
   */
  unavailable?: { problem: string; reason: string };
}

/**
 * `organizationId` replaced a `v2Enabled` boolean that came from
 * organizations.reminderV2Approved — a hand-set flag claiming a hardcoded
 * template name (centro_reminder_v2) was approved, with nothing verifying
 * that the name existed on that office's WABA at all. In production it was
 * true for an office whose WABA holds only centro_document_reminder_v3, so
 * every reminder asked Meta for a template that account does not have and
 * came back "(#100) Invalid parameter". The template is now looked up from
 * the organization's own approved rows, by intent.
 */
export async function buildReminderSend(
  conversationId: string,
  collectionRequestId: string,
  clientName: string,
  organizationId: string
): Promise<ReminderSend> {
  const missing = await listMissingRequirementNames(collectionRequestId);
  if (missing.length === 0) {
    // Shouldn't normally be reached — the scheduler already checks
    // checkCompletionGate before ever calling this — but never invents a
    // missing-document list when there genuinely isn't one.
    return {
      body: "",
      allowFreeform: false,
      unavailable: { problem: "nothing_missing", reason: "אין מסמכים חסרים — אין על מה להזכיר." },
    };
  }

  const withinWindow = await isWithinFreeformSessionWindow(conversationId);
  const missingList = missing.join(", ");

  if (withinWindow) {
    return {
      body: `היי ${clientName}, רק תזכורת קטנה — עדיין חסרים לנו: ${missingList}. אפשר לשלוח אותם כאן. תודה!`,
      allowFreeform: true,
    };
  }

  // Window closed: only a template this organization has approved on its own
  // WABA can be sent. Resolved by intent, with the parameters built in
  // whatever placeholder style that approved body actually declares.
  const resolved = await resolveApprovedTemplate(organizationId, "DOCUMENT_REMINDER");
  if (resolved.ok) {
    const listParam = formatRequirementListForTemplateParam(missing);
    return {
      body: renderTemplateBody(resolved.template, [listParam]),
      templateSend: {
        templateName: resolved.template.name,
        language: resolved.template.language,
        params: buildTemplateParams(resolved.template, [listParam]),
      },
      allowFreeform: false,
    };
  }

  return {
    body: "",
    allowFreeform: false,
    unavailable: { problem: resolved.problem, reason: resolved.reason },
  };
}
