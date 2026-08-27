import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations, whatsappTemplates } from "@/db/schema";
import { decryptWhatsAppToken } from "./tokenCipher";
import { findManagedTemplateByIntent, type TemplateIntent } from "./templateManagement";

/**
 * Everything a send needs, resolved from ONE organization and nothing else.
 *
 * Centro is multi-tenant: every office connects its own WABA, its own phone
 * number and its own token, and approves its own templates on its own
 * account. The send path used to ignore most of that — it asked Meta for a
 * hardcoded template name (centro_reminder_v2) gated on a hand-set boolean
 * (organizations.reminderV2Approved) that nothing ever verified against
 * Meta. A name approved on one WABA means nothing on another.
 *
 * Every value here is read from ONE organization row and returned together,
 * so a caller cannot end up holding one office's template with another's
 * credentials. When something is missing, this returns a typed reason — it
 * never substitutes another tenant's values.
 */

/** Why a send cannot proceed. Each maps to a stored deliveryStatus. */
export type WhatsAppConfigProblem =
  | "not_connected" // no phone number id / waba / token on this organization
  | "no_template" // this organization has no template for the intent
  | "template_not_approved"; // it has one, but Meta has not approved it

/**
 * Which credential authorises this organization's WABA.
 *
 * Centro supports two connection models and they need different tokens:
 *
 *  - "organization" — a manually connected office stored its own Access
 *    Token; only that token can act on its WABA.
 *  - "tech_provider" — an Embedded Signup office has no token of its own by
 *    design. Meta grants Centro's own System User access to the client's
 *    WABA, so the shared token is the correct and only credential for it.
 *
 * The shared token is therefore not a "fallback" to be removed — it is the
 * right answer for one of the two models. What must never happen, and is
 * what this module exists to prevent, is pairing it (or any token) with a
 * WABA or phone number belonging to a DIFFERENT organization.
 */
export type TokenSource = "organization" | "tech_provider";

export interface OrganizationWhatsAppConfig {
  organizationId: string;
  /**
   * Null when the organization has a phone number but no recorded WABA.
   * Sending does not need it — POST /{phone-number-id}/messages is
   * authorised by the token and the phone number alone — so requiring it
   * for a send would block offices that can genuinely send. It IS required
   * for template work, and resolveTemplateSendContext checks it there.
   */
  wabaId: string | null;
  phoneNumberId: string;
  /**
   * The organization's OWN decrypted token, or undefined for a Tech
   * Provider connection — where the shared System User token is the correct
   * credential and is applied by the transport (send.ts). Left undefined
   * rather than read here so resolving a config never depends on the
   * environment being configured, only on this organization's row.
   */
  accessToken: string | undefined;
  tokenSource: TokenSource;
}

export type ConfigResult =
  | { ok: true; config: OrganizationWhatsAppConfig }
  | { ok: false; problem: WhatsAppConfigProblem; reason: string };

/**
 * The organization's own WhatsApp credentials.
 *
 * All three of wabaId / phoneNumberId / token must belong to this row. A
 * missing one is a configuration error the owner has to fix, reported as
 * such — never papered over with the shared token, which would send this
 * office's message from Centro's own account.
 */
export async function resolveOrganizationWhatsAppConfig(organizationId: string): Promise<ConfigResult> {
  const db = await getDb();
  const [org] = await db
    .select({
      wabaId: organizations.whatsappBusinessAccountId,
      phoneNumberId: organizations.whatsappPhoneNumberId,
      tokenEnc: organizations.whatsappAccessTokenEnc,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!org) {
    return { ok: false, problem: "not_connected", reason: "הארגון לא נמצא." };
  }
  if (!org.phoneNumberId) {
    return {
      ok: false,
      problem: "not_connected",
      reason: "חיבור ה-WhatsApp של הארגון אינו שלם — חסר Phone Number ID.",
    };
  }

  if (org.tokenEnc) {
    try {
      return {
        ok: true,
        config: {
          organizationId,
          wabaId: org.wabaId,
          phoneNumberId: org.phoneNumberId!,
          accessToken: decryptWhatsAppToken(org.tokenEnc),
          tokenSource: "organization",
        },
      };
    } catch {
      // A stored token that cannot be decrypted is a configuration error, not
      // an invitation to try a different one: silently continuing to the
      // shared token would send this office's message from Centro's account.
      return {
        ok: false,
        problem: "not_connected",
        reason: "לא ניתן לפענח את ה-Access Token השמור של הארגון — יש לחבר מחדש.",
      };
    }
  }

  // Embedded Signup: no per-organization token by design, and Centro's own
  // System User is what Meta authorised for this client's WABA. The token
  // itself is applied by the transport.
  return {
    ok: true,
    config: {
      organizationId,
      wabaId: org.wabaId,
      phoneNumberId: org.phoneNumberId!,
      accessToken: undefined,
      tokenSource: "tech_provider",
    },
  };
}

/**
 * How a template's placeholders are written, which decides the shape of the
 * `components` Meta will accept.
 *
 * Meta rejects a positional template sent with named parameters and vice
 * versa. The two managed templates use {{1}}; the retired centro_reminder_v2
 * used {{documents}}. Reading this off the approved body — rather than
 * assuming one style — is what stops that mismatch recurring the next time a
 * template is rewritten.
 */
export type PlaceholderStyle = "positional" | "named" | "none";

export interface TemplatePlaceholders {
  style: PlaceholderStyle;
  /** For "named", the parameter names in order of first appearance. */
  names: string[];
  /** How many distinct placeholders the body declares. */
  count: number;
}

export function readTemplatePlaceholders(bodyText: string): TemplatePlaceholders {
  const tokens = [...bodyText.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/gu)].map((m) => m[1]);
  if (tokens.length === 0) return { style: "none", names: [], count: 0 };

  const positional = tokens.filter((t) => /^\d+$/.test(t));
  // A body mixing both styles is malformed; Meta would reject it. Treat it
  // as named so the caller supplies names and the error surfaces from Meta
  // with its own explanation rather than being guessed at here.
  if (positional.length === tokens.length) {
    const distinct = [...new Set(positional)].sort((a, b) => Number(a) - Number(b));
    return { style: "positional", names: [], count: distinct.length };
  }
  const names = [...new Set(tokens.filter((t) => !/^\d+$/.test(t)))];
  return { style: "named", names, count: names.length };
}

export interface ResolvedTemplate {
  intent: TemplateIntent;
  name: string;
  language: string;
  metaTemplateId: string | null;
  /** Meta's own verbatim status — only "APPROVED" ever reaches a send. */
  status: string;
  bodyText: string;
  placeholders: TemplatePlaceholders;
  /** The WABA this template was approved on, for preflight verification. */
  wabaId: string;
}

export type TemplateResult =
  | { ok: true; template: ResolvedTemplate }
  | { ok: false; problem: WhatsAppConfigProblem; reason: string; status?: string };

/**
 * This organization's approved template for a business intent.
 *
 * Matched on organizationId + intent (falling back to the managed
 * definition's name for rows recorded before `intent` existed) — never on a
 * name the code holds, and never across organizations.
 */
export async function resolveApprovedTemplate(
  organizationId: string,
  intent: TemplateIntent
): Promise<TemplateResult> {
  const db = await getDb();
  const definition = findManagedTemplateByIntent(intent);

  const rows = await db
    .select()
    .from(whatsappTemplates)
    .where(eq(whatsappTemplates.organizationId, organizationId));

  const row =
    rows.find((candidate) => candidate.intent === intent) ??
    // Rows written before the intent column existed carry the managed name.
    (definition ? rows.find((candidate) => candidate.name === definition.name) : undefined);

  if (!row) {
    return {
      ok: false,
      problem: "no_template",
      reason: `לארגון אין תבנית מסוג ${intent} — יש להגיש ולאשר אותה במסך הבעלים.`,
    };
  }
  if (row.status !== "APPROVED") {
    return {
      ok: false,
      problem: "template_not_approved",
      status: row.status,
      reason: `התבנית "${row.name}" אינה מאושרת (${row.status}) — לא ניתן לשלוח עד לאישור Meta.`,
    };
  }

  return {
    ok: true,
    template: {
      intent,
      name: row.name,
      language: row.language,
      metaTemplateId: row.metaTemplateId,
      status: row.status,
      bodyText: row.bodyText,
      placeholders: readTemplatePlaceholders(row.bodyText),
      wabaId: row.wabaId,
    },
  };
}

/**
 * Builds the body parameters in the exact style the approved template
 * declares. `values` are supplied in placeholder order.
 */
export function buildTemplateParams(
  template: ResolvedTemplate,
  values: string[]
): Array<string | { name: string; value: string }> {
  const { placeholders } = template;
  if (placeholders.style === "none") return [];
  if (placeholders.style === "named") {
    return placeholders.names.map((name, index) => ({ name, value: values[index] ?? "" }));
  }
  return values.slice(0, placeholders.count);
}

/**
 * The approved body with its placeholders filled in — what we store as the
 * message row, so the thread shows what the client actually received rather
 * than a separately-worded copy that could drift from the approved text.
 */
export function renderTemplateBody(template: ResolvedTemplate, values: string[]): string {
  const { placeholders } = template;
  if (placeholders.style === "none") return template.bodyText;
  if (placeholders.style === "named") {
    return placeholders.names.reduce(
      (body, name, index) =>
        body.replace(new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, "gu"), values[index] ?? ""),
      template.bodyText
    );
  }
  return template.bodyText.replace(/\{\{\s*(\d+)\s*\}\}/gu, (_match, digits: string) => {
    const index = Number(digits) - 1;
    return values[index] ?? "";
  });
}

/**
 * Everything needed for one send, resolved together so a caller cannot get
 * a template from one organization and credentials from another.
 */
export type SendContextResult =
  | {
      ok: true;
      config: OrganizationWhatsAppConfig;
      template: ResolvedTemplate;
    }
  | { ok: false; problem: WhatsAppConfigProblem; reason: string };

export async function resolveTemplateSendContext(
  organizationId: string,
  intent: TemplateIntent
): Promise<SendContextResult> {
  const config = await resolveOrganizationWhatsAppConfig(organizationId);
  if (!config.ok) return config;

  const template = await resolveApprovedTemplate(organizationId, intent);
  if (!template.ok) return { ok: false, problem: template.problem, reason: template.reason };

  // The template must live on the SAME WABA the credentials point at. A row
  // keeps the WABA it was approved on (schema.ts says why), so a reconnected
  // organization can hold a template belonging to its previous account —
  // sending that would be a cross-account send with this account's token.
  if (config.config.wabaId && template.template.wabaId !== config.config.wabaId) {
    return {
      ok: false,
      problem: "no_template",
      reason:
        `התבנית "${template.template.name}" אושרה על WABA אחר (${template.template.wabaId}) ` +
        `מזה שהארגון מחובר אליו כעת (${config.config.wabaId}) — יש לסנכרן מחדש את התבניות.`,
    };
  }

  return { ok: true, config: config.config, template: template.template };
}
