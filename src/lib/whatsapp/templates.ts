import { withRetry } from "@/lib/resilience";
import { getWhatsAppConfig, GRAPH_API_BASE } from "./config";

export class WhatsAppTemplateError extends Error {}

export interface TemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  bodyText: string;
  // Required by Meta for any template whose bodyText contains {{1}},
  // {{2}}, ... POSITIONAL placeholders — one example value per
  // placeholder, in order. Omitting this for a parameterized template
  // doesn't just get rejected for policy reasons, it fails submission
  // outright with rejected_reason: INVALID_FORMAT (confirmed live: this is
  // exactly what happened to LEAD_WELCOME_TEMPLATE before this field
  // existed). Mutually exclusive with namedExampleParams below — a
  // template uses one placeholder style or the other, never both.
  exampleParams?: string[];
  // The equivalent requirement for a template whose bodyText instead uses
  // NAMED {{variable_name}}-style placeholders (centro_reminder_v2's own
  // {{documents}}) — Meta's submission API wants
  // example.body_text_named_params, a {param_name, example} pair per
  // placeholder, not a plain positional array.
  namedExampleParams?: Array<{ paramName: string; example: string }>;
}

// Single source of truth for the four automated ("ai") message bodies —
// conversationOrchestration.ts and scheduler.ts both import the text
// constants below instead of declaring their own copies, so a template's
// approved wording can never silently drift out of sync with what
// TEMPLATE_BY_BODY looks up.
export const INITIAL_REQUEST_BODY =
  "שלום! זהו סנטרו, העוזר הדיגיטלי של המשרד. נשמח לקבל את המסמכים הנדרשים לתקופה הנוכחית.";
// Phase 2 replacement for the static initial request: a parameterized
// template whose {{1}} carries the actual, per-request document list (built
// dynamically from collectionRequestRequirements). Submitted to Meta for
// approval now (it's in REQUIRED_TEMPLATES below), but the live send path is
// NOT switched to it until the WABA's copy is APPROVED — the exchange still
// uses centro_initial_request until then. {{1}} is a single-line,
// comma-separated list (Meta forbids newlines in body parameters).
export const INITIAL_REQUEST_V2_BODY =
  "שלום! זהו סנטרו, העוזר הדיגיטלי של המשרד. כדי שנוכל להמשיך בטיפול בבקשה, נא שלחו את המסמכים הבאים: {{1}}";
export const INITIAL_REQUEST_V2_TEMPLATE_NAME = "centro_initial_request_v2";
// Master switch for actually SENDING the parameterized v2 template over
// WhatsApp. centro_initial_request_v2 was approved on the WABA on
// 2026-08-05 — flipped to true. The initial request now sends the
// dynamic per-request document list via {{1}}; centro_initial_request
// (static, no params) remains the fallback used when a request has zero
// requirements (see buildInitialRequestSend).
export const INITIAL_REQUEST_V2_ENABLED = true;
export const THANK_YOU_BODY =
  "תודה, קיבלנו את המסמכים! האם סיימתם לשלוח את כל המסמכים? השיבו 'סיימתי' או 'יש עוד מסמכים'.";
export const REMINDER_BODY = "תזכורת: עדיין ממתינים לתשובתכם - 'סיימתי' או 'יש עוד מסמכים'?";
// Dynamic reminder — lists exactly which documents are still missing,
// instead of the static REMINDER_BODY's generic "still waiting for your
// answer." Submitted to Meta directly via the Business Manager UI (not
// this codebase's own ensureTemplatesProvisioned) as a NAMED-parameter
// template — the single placeholder is {{documents}}, not a positional
// {{1}}/{{2}} — this exact body text, word for word, is what's pending
// review; it must never be edited without resubmitting to Meta. The
// parameter value itself must still be a single line, comma-separated
// (Meta forbids newlines inside a template PARAMETER — the static body
// text itself may and does contain real newlines, those are fine).
// Currently PENDING REVIEW on the WABA, not yet approved — see
// REMINDER_V2_ENABLED.
export const REMINDER_V2_BODY =
  "שלום,\n\nרצינו להזכיר שעדיין חסרים המסמכים הבאים:\n\n{{documents}}\n\nלאחר קבלת כל המסמכים הנדרשים, הבקשה תושלם באופן אוטומטי.\n\nתודה.";
export const REMINDER_V2_TEMPLATE_NAME = "centro_reminder_v2";
// The exact name of the template's own named parameter — must match
// precisely what was submitted to Meta (see REMINDER_V2_BODY's own doc
// comment); sendTemplateMessage's named-parameter form matches by this
// string, not by array position.
export const REMINDER_V2_PARAM_NAME = "documents";
// Master switch for actually SENDING the parameterized v2 reminder
// template over WhatsApp — false until centro_reminder_v2 is APPROVED on
// the WABA. Until then, src/lib/reminderContent.ts falls back to the
// already-approved static REMINDER_BODY, exactly today's behavior. THE
// ONLY THING TO CHANGE ONCE META APPROVES: flip this to true. No other
// code change is needed — the send path, named-parameter mapping, and
// fallback are already fully wired and tested.
export const REMINDER_V2_ENABLED = false;
export const DUPLICATE_BODY = "קיבלנו מסמך זה כבר, תודה.";

// WhatsApp forbids free-form messages to anyone who hasn't messaged the
// business first (see the WhatsApp plan's Message Template constraint) —
// every automated first-contact-style send must be one of these four
// pre-approved templates. UTILITY (not MARKETING) category: these are
// transactional document-collection messages, not promotional content,
// so they don't require marketing opt-in and get faster review.
export const REQUIRED_TEMPLATES: TemplateDefinition[] = [
  { name: "centro_initial_request", language: "he", category: "UTILITY", bodyText: INITIAL_REQUEST_BODY },
  // Phase 2 — provisioned for approval now, activated in code only once
  // approved on the WABA. exampleParams satisfies Meta's requirement that a
  // {{1}} template ship one example value per placeholder.
  {
    name: "centro_initial_request_v2",
    language: "he",
    category: "UTILITY",
    bodyText: INITIAL_REQUEST_V2_BODY,
    exampleParams: ["תעודת זהות, דפי חשבון בנק, דו״ח תיק השקעות"],
  },
  { name: "centro_thank_you_confirm", language: "he", category: "UTILITY", bodyText: THANK_YOU_BODY },
  { name: "centro_reminder", language: "he", category: "UTILITY", bodyText: REMINDER_BODY },
  // Already submitted by hand via the Business Manager UI (not by this
  // provisioning code) as a NAMED-parameter template — this entry exists
  // so ensureTemplatesProvisioned recognizes it as already-existing by
  // name+language and never attempts a duplicate submission, and so any
  // future organization that doesn't have it yet gets it submitted with
  // the exact same named-parameter shape Meta already has on file.
  {
    name: REMINDER_V2_TEMPLATE_NAME,
    language: "he",
    category: "UTILITY",
    bodyText: REMINDER_V2_BODY,
    namedExampleParams: [{ paramName: REMINDER_V2_PARAM_NAME, example: "תעודת זהות, 3 תלושי שכר, דפי בנק" }],
  },
  { name: "centro_duplicate_document", language: "he", category: "UTILITY", bodyText: DUPLICATE_BODY },
];

export const TEMPLATE_BY_BODY: ReadonlyMap<string, TemplateDefinition> = new Map(
  REQUIRED_TEMPLATES.map((template) => [template.bodyText, template])
);

// Feature 1 (M-WA-5) — sent only from Centro's own sales number
// (CENTRO_WHATSAPP_PHONE_NUMBER_ID) to a landing-page lead, never
// auto-provisioned per connecting organization the way REQUIRED_TEMPLATES
// is, since customer orgs never send this one. {{1}} is the lead's name.
//
// Requested as UTILITY, but confirmed live that Meta's own content
// classifier overrides this to MARKETING regardless of what's requested
// here — submitting UTILITY doesn't fail, it's just silently ignored in
// favor of Meta's own categorization. The category field below reflects
// what actually governs sending (Meta's applied category), not our
// original intent: MARKETING messages need the recipient to have
// opted in, which "filled out a contact form" may or may not satisfy
// depending on how strictly Meta enforces it — worth confirming once
// this template clears review and a real send is attempted.
export const LEAD_WELCOME_TEMPLATE: TemplateDefinition = {
  name: "centro_lead_welcome_v2",
  language: "he",
  category: "MARKETING",
  bodyText: "שלום {{1}}, תודה שפניתם ל-Centro! קיבלנו את הפנייה שלכם ונחזור אליכם בהקדם.",
  exampleParams: ["ישראל"],
};

// Idempotent — lists existing templates on the WABA first and only
// submits ones that don't already exist (by name+language), so this is
// safe to call every time a signup completes (per the plan's
// recommendation to auto-provision immediately after Embedded Signup)
// without ever duplicating or re-submitting an already-approved
// template. Each submission is independently best-effort: one template
// failing to submit (e.g. this WABA hasn't finished its own review yet)
// must never block the others or the connection itself from completing.
// `templates` defaults to the four per-org ones; the one-time lead-welcome
// setup for Centro's own WABA passes [LEAD_WELCOME_TEMPLATE] instead.
export async function ensureTemplatesProvisioned(
  wabaId: string,
  templates: TemplateDefinition[] = REQUIRED_TEMPLATES
): Promise<void> {
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

  for (const template of templates) {
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
          components: [
            {
              type: "BODY",
              text: template.bodyText,
              ...(template.exampleParams ? { example: { body_text: [template.exampleParams] } } : {}),
              ...(template.namedExampleParams
                ? {
                    example: {
                      body_text_named_params: template.namedExampleParams.map(({ paramName, example }) => ({
                        param_name: paramName,
                        example,
                      })),
                    },
                  }
                : {}),
            },
          ],
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
