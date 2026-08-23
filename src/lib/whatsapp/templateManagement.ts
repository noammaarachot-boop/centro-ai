import { withRetry } from "@/lib/resilience";
import { GRAPH_API_BASE } from "./config";

// Owner-managed, per-organization WhatsApp message templates.
//
// Deliberately independent of templates.ts's ensureTemplatesProvisioned:
// that one provisions the code-defined REQUIRED_TEMPLATES with the SHARED
// system-user token (correct for Embedded Signup organizations, whose WABA
// that token has access to). Everything here instead acts on ONE
// organization's own WABA with that organization's OWN access token, which
// is the only token that works for a manually-connected office.
//
// Every function here is server-side only: the sole callers are the
// owner's "use server" actions and the server-side data layer, and an
// access token is only ever read (decrypted) inside those callers and
// passed in as an argument. No token, encrypted or otherwise, is ever
// returned toward the browser — the owner overview deliberately exposes
// only booleans/status strings (see src/lib/data/owner/templates.ts).
// Same convention as wabaTokens.ts and tokenCipher.ts, which are
// server-only by call-site discipline rather than by an extra dependency.

const TEMPLATE_REQUEST_TIMEOUT_MS = 15_000;

export class WhatsAppTemplateSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhatsAppTemplateSubmissionError";
  }
}

// The single positional placeholder both managed templates use. {{1}} is
// ALWAYS the dynamic document list — never a client name or any other
// value — so the example below is representative of what really gets
// substituted at send time.
export const DOCUMENT_LIST_PLACEHOLDER = "{{1}}";
export const DEFAULT_DOCUMENT_LIST_EXAMPLE = "תעודת זהות, 3 תלושי שכר ואישור ניהול חשבון";

export interface ManagedTemplateDefinition {
  /** Meta template name: lowercase letters, digits and underscores only. */
  name: string;
  /** Hebrew label for the owner screen. */
  label: string;
  language: string;
  category: "UTILITY" | "MARKETING" | "AUTHENTICATION";
  bodyText: string;
}

// New names on purpose — the existing centro_initial_request_v2 /
// centro_reminder_v2 are left completely untouched (different wording,
// already submitted, and still what the live send path is gated on), so
// nothing here can affect the current messaging behavior.
//
// UTILITY: these are transactional document-collection messages, not
// promotional content — no marketing opt-in required, and faster review.
// Note Meta's own classifier can still override the requested category.
//
// Real newlines in the BODY text are fine and intentional; Meta only
// forbids newlines inside a substituted PARAMETER value at send time.
// Meta rule, confirmed live on the first real submission: a placeholder
// may not sit at the very start OR the very end of the body — it must be
// surrounded by static text. Both bodies below therefore close with a
// fixed sentence after {{1}}. isPlaceholderPositionValid() below encodes
// the rule so this can never silently regress.
export const MANAGED_TEMPLATES: ManagedTemplateDefinition[] = [
  {
    name: "centro_document_request_v3",
    label: "בקשת מסמכים",
    language: "he",
    category: "UTILITY",
    bodyText:
      "שלום, לצורך המשך הטיפול נשמח לקבל את המסמכים הבאים:\n{{1}}\nתודה, לאחר קבלת המסמכים נוכל להמשיך בטיפול.",
  },
  {
    name: "centro_document_reminder_v3",
    label: "תזכורת",
    language: "he",
    category: "UTILITY",
    bodyText:
      "שלום, זוהי תזכורת בנוגע למסמכים שעדיין חסרים להמשך הטיפול:\n{{1}}\nנשמח לקבל את המסמכים בהקדם כדי שנוכל להמשיך בטיפול.",
  },
];

// Meta rejects a body whose placeholder is the first or last thing in it.
// Checked against the trimmed body, since leading/trailing whitespace is
// not "static text" as far as Meta is concerned.
export function isPlaceholderPositionValid(bodyText: string): boolean {
  const trimmed = bodyText.trim();
  return !trimmed.startsWith("{{") && !trimmed.endsWith("}}");
}

export function findManagedTemplate(name: string): ManagedTemplateDefinition | undefined {
  return MANAGED_TEMPLATES.find((template) => template.name === name);
}

// Meta rejects a parameterized template outright (rejected_reason:
// INVALID_FORMAT) when the example is missing, and rejects newlines inside
// a parameter value. Validated before submission so the owner gets an
// immediate, specific Hebrew error instead of an opaque Meta rejection
// hours later.
export function validateExampleValue(example: string): string | null {
  const trimmed = example.trim();
  if (!trimmed) return "יש להזין ערך לדוגמה עבור {{1}} — Meta דוחה תבנית עם משתנה ללא דוגמה.";
  if (/[\r\n]/.test(trimmed)) return "הערך לדוגמה לא יכול לכלול ירידת שורה — Meta אוסרת זאת בערך של משתנה.";
  if (trimmed.length > 250) return "הערך לדוגמה ארוך מדי (עד 250 תווים).";
  return null;
}

async function readError(response: Response): Promise<string> {
  const body = await response.text();
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; error_user_msg?: string } };
    return parsed.error?.error_user_msg ?? parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

export interface SubmittedTemplate {
  metaTemplateId: string;
  status: string;
  category: string;
}

// POST /{waba-id}/message_templates — creates the template and puts it into
// Meta's review queue. Returns Meta's own id and initial status.
export async function submitTemplateToMeta(params: {
  wabaId: string;
  accessToken: string;
  name: string;
  language: string;
  category: string;
  bodyText: string;
  exampleValues: string[];
}): Promise<SubmittedTemplate> {
  const response = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(params.wabaId)}/message_templates`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TEMPLATE_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        name: params.name,
        language: params.language,
        category: params.category,
        components: [
          {
            type: "BODY",
            text: params.bodyText,
            // Meta's shape for positional placeholders: an array of example
            // SETS, each holding one value per {{n}} in order.
            example: { body_text: [params.exampleValues] },
          },
        ],
      }),
    })
  );

  if (!response.ok) {
    throw new WhatsAppTemplateSubmissionError(await readError(response));
  }

  const data = (await response.json()) as { id?: string; status?: string; category?: string };
  if (!data.id) {
    throw new WhatsAppTemplateSubmissionError("Meta לא החזירה מזהה תבנית. נסו שוב.");
  }
  return {
    metaTemplateId: data.id,
    status: data.status ?? "PENDING",
    category: data.category ?? params.category,
  };
}

// POST /{template-id} — the ONLY correct way to resubmit a rejected
// template: Meta refuses a second create under a name that already exists
// on the WABA, so a rejected template is edited in place, which puts it
// back into review.
export async function editTemplateInMeta(params: {
  metaTemplateId: string;
  accessToken: string;
  category: string;
  bodyText: string;
  exampleValues: string[];
}): Promise<void> {
  const response = await withRetry(() =>
    fetch(`${GRAPH_API_BASE}/${encodeURIComponent(params.metaTemplateId)}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(TEMPLATE_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        category: params.category,
        components: [
          {
            type: "BODY",
            text: params.bodyText,
            example: { body_text: [params.exampleValues] },
          },
        ],
      }),
    })
  );

  if (!response.ok) {
    throw new WhatsAppTemplateSubmissionError(await readError(response));
  }
}

export interface MetaTemplateStatus {
  metaTemplateId: string;
  name: string;
  language: string;
  status: string;
  category: string;
  rejectedReason: string | null;
}

// GET /{waba-id}/message_templates — the WABA's current view of every
// template on it, used to refresh stored statuses. Meta reports
// rejected_reason as the string "NONE" when there is no rejection;
// normalized to null so a caller never stores a meaningless reason.
export async function fetchTemplateStatuses(
  wabaId: string,
  accessToken: string
): Promise<MetaTemplateStatus[]> {
  const response = await withRetry(() =>
    fetch(
      `${GRAPH_API_BASE}/${encodeURIComponent(wabaId)}/message_templates` +
        `?fields=id,name,language,status,category,rejected_reason&limit=100`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(TEMPLATE_REQUEST_TIMEOUT_MS),
      }
    )
  );

  if (!response.ok) {
    throw new WhatsAppTemplateSubmissionError(await readError(response));
  }

  const data = (await response.json()) as {
    data?: Array<{
      id: string;
      name: string;
      language: string;
      status: string;
      category?: string;
      rejected_reason?: string | null;
    }>;
  };

  return (data.data ?? []).map((row) => ({
    metaTemplateId: row.id,
    name: row.name,
    language: row.language,
    status: row.status,
    category: row.category ?? "UTILITY",
    rejectedReason:
      row.rejected_reason && row.rejected_reason.toUpperCase() !== "NONE" ? row.rejected_reason : null,
  }));
}

// Meta's rejected_reason codes are terse and English-only; the owner
// screen shows a real explanation instead. An unrecognized code falls
// through to the raw value rather than being hidden.
const REJECTION_REASONS: Record<string, string> = {
  INVALID_FORMAT:
    "מבנה התבנית נדחה — לרוב חסר ערך לדוגמה עבור {{1}}, או שיש בו ירידת שורה או עיצוב שאינו מותר.",
  ABUSIVE_CONTENT: "Meta סיווגה את התוכן כפוגעני או מטעה.",
  INCORRECT_CATEGORY: "הקטגוריה שנבחרה אינה תואמת את תוכן ההודעה — ייתכן שיש לבחור קטגוריה אחרת.",
  SCAM: "Meta חשדה שהתוכן מהווה הונאה.",
  PROMOTIONAL: "התוכן סווג כשיווקי — תבנית בקטגוריית UTILITY אינה יכולה לכלול תוכן פרסומי.",
  TAG_CONTENT_MISMATCH: "התוכן אינו תואם את הקטגוריה שנבחרה.",
};

export function describeRejectionReason(reason: string | null): string | null {
  if (!reason) return null;
  return REJECTION_REASONS[reason.toUpperCase()] ?? reason;
}
