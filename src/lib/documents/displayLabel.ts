// The one place any surface a human reads (office-employee UI, WhatsApp
// messages to the client, confirmation questions, AI prompt context, audit
// descriptions, dashboard cards) may turn a document into a label. Never
// reads documents.fileName, which is a storage key only (for a real
// WhatsApp attachment, derived from the message id — never something a
// human typed; images never carry a real filename from Meta at all).
//
// Resolution order: the document's own displayLabel (set once at intake
// from the AI classifier's already-computed type, e.g. "תעודת זהות") →
// the requirement it's matched to, if any → a generic, honest fallback.
// Never fileName, never a guess.
export function resolveDocumentDisplayLabel(
  displayLabel: string | null | undefined,
  requirementName?: string | null
): string {
  const trimmedLabel = displayLabel?.trim();
  if (trimmedLabel) return trimmedLabel;
  const trimmedRequirement = requirementName?.trim();
  if (trimmedRequirement) return trimmedRequirement;
  return "מסמך שהתקבל";
}

// The one shared placeholder text for an inbound conversation message that
// is only an attachment (no caption) — written once, at intake time,
// before classification has run (src/app/api/webhooks/whatsapp/route.ts,
// the DevTools simulator in conversationActions.ts), when there is
// genuinely no label to show yet. The conversation thread's own display
// layer later checks for this exact string and — without ever rewriting
// the stored message — upgrades it to the real resolveDocumentDisplayLabel()
// once the matching document (joined via messages.whatsappMessageId ===
// documents.whatsappMessageId) has been classified. Never the raw storage
// filename at either point.
export const ATTACHMENT_PLACEHOLDER_TEXT = "[קובץ מצורף]";

// The conversation thread's own display-time upgrade — a pure function so
// it's directly testable without a DB/React render. Never mutates
// anything; a caller (the collection request page) is the one deciding
// whether to persist nothing at all, which it never does.
export function resolveMessageDisplayBody(messageBody: string, resolvedDocumentLabel: string | undefined): string {
  if (messageBody !== ATTACHMENT_PLACEHOLDER_TEXT || !resolvedDocumentLabel) return messageBody;
  return `[קובץ מצורף: ${resolvedDocumentLabel}]`;
}
