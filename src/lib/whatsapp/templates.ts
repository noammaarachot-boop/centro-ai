import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppTemplateError extends Error {}

export interface TemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  bodyText: string;
}

// Single source of truth for the four automated ("ai") message bodies —
// conversationOrchestration.ts and scheduler.ts both import the text
// constants below instead of declaring their own copies, so a template's
// approved wording can never silently drift out of sync with what
// TEMPLATE_BY_BODY looks up.
export const INITIAL_REQUEST_BODY =
  "שלום! זהו סנטרו, העוזר הדיגיטלי של המשרד. נשמח לקבל את המסמכים הנדרשים לתקופה הנוכחית.";
export const THANK_YOU_BODY =
  "תודה, קיבלנו את המסמכים! האם סיימתם לשלוח את כל המסמכים? השיבו 'סיימתי' או 'יש עוד מסמכים'.";
export const REMINDER_BODY = "תזכורת: עדיין ממתינים לתשובתכם - 'סיימתי' או 'יש עוד מסמכים'?";
export const DUPLICATE_BODY = "קיבלנו מסמך זה כבר, תודה.";

// WhatsApp forbids free-form messages to anyone who hasn't messaged the
// business first (see the WhatsApp plan's Message Template constraint) —
// every automated first-contact-style send must be one of these four
// pre-approved templates. UTILITY (not MARKETING) category: these are
// transactional document-collection messages, not promotional content,
// so they don't require marketing opt-in and get faster review.
export const REQUIRED_TEMPLATES: TemplateDefinition[] = [
  { name: "centro_initial_request", language: "he", category: "UTILITY", bodyText: INITIAL_REQUEST_BODY },
  { name: "centro_thank_you_confirm", language: "he", category: "UTILITY", bodyText: THANK_YOU_BODY },
  { name: "centro_reminder", language: "he", category: "UTILITY", bodyText: REMINDER_BODY },
  { name: "centro_duplicate_document", language: "he", category: "UTILITY", bodyText: DUPLICATE_BODY },
];

export const TEMPLATE_BY_BODY: ReadonlyMap<string, TemplateDefinition> = new Map(
  REQUIRED_TEMPLATES.map((template) => [template.bodyText, template])
);

// Idempotent — lists existing templates on the WABA first and only
// submits ones that don't already exist (by name+language), so this is
// safe to call every time a signup completes (per the plan's
// recommendation to auto-provision immediately after Embedded Signup)
// without ever duplicating or re-submitting an already-approved
// template. Each submission is independently best-effort: one template
// failing to submit (e.g. this WABA hasn't finished its own review yet)
// must never block the others or the connection itself from completing.
export async function ensureTemplatesProvisioned(wabaId: string): Promise<void> {
  const { systemUserToken } = getWhatsAppConfig();

  const existingResponse = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/message_templates?fields=name,language&limit=100`,
      { headers: { Authorization: `Bearer ${systemUserToken}` } }
    )
  );
  if (!existingResponse.ok) {
    const body = await existingResponse.text();
    throw new WhatsAppTemplateError(`Failed to list existing templates (${existingResponse.status}): ${body}`);
  }
  const existingData = (await existingResponse.json()) as {
    data?: Array<{ name: string; language: string }>;
  };
  const existingKeys = new Set((existingData.data ?? []).map((t) => `${t.name}:${t.language}`));

  for (const template of REQUIRED_TEMPLATES) {
    if (existingKeys.has(`${template.name}:${template.language}`)) continue;

    const createResponse = await withRetry(() =>
      fetch(`${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/message_templates`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${systemUserToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: template.name,
          language: template.language,
          category: template.category,
          components: [{ type: "BODY", text: template.bodyText }],
        }),
      })
    );
    if (!createResponse.ok) {
      const body = await createResponse.text();
      console.error(
        `[whatsapp] template "${template.name}" submission failed (${createResponse.status}): ${body}`
      );
    }
  }
}
