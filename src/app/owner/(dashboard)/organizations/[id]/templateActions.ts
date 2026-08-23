"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { organizations, whatsappTemplates } from "@/db/schema";
import { requireOwnerSession } from "@/lib/auth/ownerSession";
import { recordOwnerAuditEvent } from "@/lib/owner/audit";
import { findOrganizationTemplate } from "@/lib/data/owner/templates";
import { decryptWhatsAppToken } from "@/lib/whatsapp/tokenCipher";
import {
  DEFAULT_DOCUMENT_LIST_EXAMPLE,
  DOCUMENT_LIST_PLACEHOLDER,
  MANAGED_TEMPLATES,
  editTemplateInMeta,
  fetchTemplateStatuses,
  findManagedTemplate,
  resolveEditEligibility,
  submitTemplateToMeta,
  validateExampleValue,
  WhatsAppTemplateSubmissionError,
} from "@/lib/whatsapp/templateManagement";

// Owner-managed WhatsApp templates, per organization.
//
// Every action resolves the organization's OWN wabaId and OWN access token
// server-side, decrypts the token only here, and hands it straight to
// Meta. The token is never returned to a caller, never logged, and never
// reaches the browser. Each action is independently gated by
// requireOwnerSession() — a layout only protects pages, not the actions
// they invoke — and every read/write is pinned to the organizationId from
// the submitted form, so one organization can never touch another's
// templates.
//
// Kept in its own file rather than appended to actions.ts: these are a
// self-contained feature, and nothing here touches the existing
// connection/suspension actions.

interface OrganizationWhatsAppContext {
  wabaId: string;
  accessToken: string;
}

// Null when the organization has no usable manual WhatsApp connection — a
// template can only be submitted to a real WABA with a token holding
// whatsapp_business_management on it. Embedded-Signup organizations have
// no per-org token, so template management here simply isn't offered for
// them (their templates keep being provisioned the existing way).
async function resolveWhatsAppContext(
  organizationId: string
): Promise<OrganizationWhatsAppContext | null> {
  const db = await getDb();
  const [org] = await db
    .select({
      wabaId: organizations.whatsappBusinessAccountId,
      tokenEnc: organizations.whatsappAccessTokenEnc,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);

  if (!org?.wabaId || !org.tokenEnc) return null;
  return { wabaId: org.wabaId, accessToken: decryptWhatsAppToken(org.tokenEnc) };
}

function templateRedirect(organizationId: string, params: Record<string, string>): never {
  const query = new URLSearchParams(params).toString();
  redirect(`/owner/organizations/${organizationId}?${query}#whatsapp-templates`);
}

// First submission, or — when Meta already holds the template and rejected
// it — an in-place edit, which is the only resubmission Meta accepts (a
// second create under an existing name fails outright).
export async function submitWhatsAppTemplateAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const name = String(formData.get("templateName") ?? "").trim();
  const exampleValue = String(formData.get("exampleValue") ?? "").trim();

  const definition = findManagedTemplate(name);
  if (!definition) templateRedirect(organizationId, { templateError: "תבנית לא מוכרת." });

  const exampleError = validateExampleValue(exampleValue);
  if (exampleError) templateRedirect(organizationId, { templateError: exampleError });

  const context = await resolveWhatsAppContext(organizationId);
  if (!context) {
    templateRedirect(organizationId, {
      templateError: "לארגון הזה אין חיבור WhatsApp ידני עם טוקן שמור — יש לחבר אותו לפני הגשת תבניות.",
    });
  }

  const db = await getDb();
  const existing = await findOrganizationTemplate(organizationId, definition.name, definition.language);
  const exampleValues = [exampleValue];

  try {
    if (existing?.metaTemplateId) {
      await editTemplateInMeta({
        metaTemplateId: existing.metaTemplateId,
        accessToken: context.accessToken,
        category: definition.category,
        bodyText: definition.bodyText,
        exampleValues,
      });
      await db
        .update(whatsappTemplates)
        .set({
          bodyText: definition.bodyText,
          exampleValues,
          // An accepted edit puts the template back into review; the stale
          // rejection reason must not linger next to a PENDING status.
          status: "PENDING",
          rejectedReason: null,
          lastSyncedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(whatsappTemplates.id, existing.id));
    } else {
      const submitted = await submitTemplateToMeta({
        wabaId: context.wabaId,
        accessToken: context.accessToken,
        name: definition.name,
        language: definition.language,
        category: definition.category,
        bodyText: definition.bodyText,
        exampleValues,
      });

      const values = {
        organizationId,
        wabaId: context.wabaId,
        name: definition.name,
        language: definition.language,
        // Meta's returned category wins over the requested one — its own
        // classifier can reclassify a template on submission.
        category: submitted.category,
        bodyText: definition.bodyText,
        variables: [DOCUMENT_LIST_PLACEHOLDER],
        exampleValues,
        metaTemplateId: submitted.metaTemplateId,
        status: submitted.status,
        rejectedReason: null,
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      };

      if (existing) {
        await db.update(whatsappTemplates).set(values).where(eq(whatsappTemplates.id, existing.id));
      } else {
        await db.insert(whatsappTemplates).values(values);
      }
    }
  } catch (error) {
    // Meta's own message is surfaced (it names the real problem, e.g. a
    // malformed example) but never the token, which is not part of it.
    const message =
      error instanceof WhatsAppTemplateSubmissionError
        ? `Meta דחתה את ההגשה: ${error.message}`
        : "ההגשה ל-Meta נכשלה. נסו שוב.";
    console.error("[owner] submitWhatsAppTemplate failed", {
      organizationId,
      templateName: definition.name,
      error: error instanceof Error ? error.message : String(error),
    });
    templateRedirect(organizationId, { templateError: message });
  }

  await recordOwnerAuditEvent({
    eventType: "owner.whatsapp_template_submitted",
    description: `תבנית WhatsApp "${definition.label}" הוגשה לאישור Meta על ידי ${session.email}`,
    severity: "info",
    platformOwnerId: session.platformOwnerId,
    metadata: {
      organizationId,
      templateName: definition.name,
      resubmission: !!existing?.metaTemplateId,
    },
  });

  templateRedirect(organizationId, { templateSubmitted: definition.label });
}

// Re-reads each managed template's current state straight from the
// organization's own WABA, so PENDING → APPROVED/REJECTED (and any
// category reclassification by Meta) shows up without waiting on a
// webhook.
export async function refreshWhatsAppTemplateStatusesAction(formData: FormData) {
  await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const context = await resolveWhatsAppContext(organizationId);
  if (!context) {
    templateRedirect(organizationId, {
      templateError: "לארגון הזה אין חיבור WhatsApp ידני עם טוקן שמור.",
    });
  }

  let statuses;
  try {
    statuses = await fetchTemplateStatuses(context.wabaId, context.accessToken);
  } catch (error) {
    console.error("[owner] refreshWhatsAppTemplateStatuses failed", {
      organizationId,
      error: error instanceof Error ? error.message : String(error),
    });
    templateRedirect(organizationId, { templateError: "רענון הסטטוס מול Meta נכשל. נסו שוב." });
  }

  const db = await getDb();
  let synced = 0;
  for (const definition of MANAGED_TEMPLATES) {
    const remote = statuses.find(
      (candidate) => candidate.name === definition.name && candidate.language === definition.language
    );
    if (!remote) continue; // not on this WABA yet — nothing to sync

    const existing = await findOrganizationTemplate(organizationId, definition.name, definition.language);
    const values = {
      status: remote.status,
      category: remote.category,
      rejectedReason: remote.rejectedReason,
      metaTemplateId: remote.metaTemplateId,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };

    if (existing) {
      await db.update(whatsappTemplates).set(values).where(eq(whatsappTemplates.id, existing.id));
    } else {
      // On the WABA but never recorded here (e.g. submitted directly in
      // Meta's own UI) — adopt it rather than reporting nothing.
      await db.insert(whatsappTemplates).values({
        organizationId,
        wabaId: context.wabaId,
        name: definition.name,
        language: definition.language,
        bodyText: definition.bodyText,
        variables: [DOCUMENT_LIST_PLACEHOLDER],
        exampleValues: [DEFAULT_DOCUMENT_LIST_EXAMPLE],
        ...values,
      });
    }
    synced += 1;
  }

  templateRedirect(organizationId, { templateRefreshed: String(synced) });
}

// Edits an already-submitted template in Meta.
//
// The contract the whole feature rests on: Meta is the source of truth.
// The local row is written ONLY after Meta accepts the edit, so the screen
// can never claim "נשמר" for a change Meta rejected. On failure nothing is
// written and Meta's own error is shown.
//
// Scope is deliberately narrow — the example value and the category, the
// two fields Meta's edit endpoint accepts that cannot break the send path.
// The body text is NOT editable here: {{1}} must stay a single positional
// placeholder in a legal position (Meta rejects it at the very start or
// end), and a free-text editor would let that be broken in one click.
export async function editWhatsAppTemplateAction(formData: FormData) {
  const session = await requireOwnerSession();
  const organizationId = String(formData.get("organizationId") ?? "");
  if (!organizationId) redirect("/owner/organizations");

  const name = String(formData.get("templateName") ?? "").trim();
  const exampleValue = String(formData.get("exampleValue") ?? "").trim();

  const definition = findManagedTemplate(name);
  if (!definition) templateRedirect(organizationId, { templateError: "תבנית לא מוכרת." });

  const exampleError = validateExampleValue(exampleValue);
  if (exampleError) templateRedirect(organizationId, { templateError: exampleError });

  const existing = await findOrganizationTemplate(organizationId, definition.name, definition.language);
  if (!existing) {
    templateRedirect(organizationId, { templateError: "התבנית עדיין לא הוגשה ל-Meta." });
  }

  // Re-checked server-side, never trusted from the disabled state of a button.
  const eligibility = resolveEditEligibility({
    status: existing.status,
    metaTemplateId: existing.metaTemplateId,
    lastEditedAt: existing.lastEditedAt,
  });
  if (!eligibility.canEdit) {
    templateRedirect(organizationId, { templateError: eligibility.blockedReason ?? "לא ניתן לערוך." });
  }

  const context = await resolveWhatsAppContext(organizationId);
  if (!context) {
    templateRedirect(organizationId, {
      templateError: "לארגון הזה אין חיבור WhatsApp ידני עם טוקן שמור.",
    });
  }

  try {
    await editTemplateInMeta({
      metaTemplateId: existing.metaTemplateId!,
      accessToken: context.accessToken,
      category: definition.category,
      bodyText: definition.bodyText,
      exampleValues: [exampleValue],
    });
  } catch (error) {
    const message =
      error instanceof WhatsAppTemplateSubmissionError
        ? `Meta דחתה את העריכה: ${error.message}`
        : "העריכה מול Meta נכשלה. נסו שוב.";
    console.error("[owner] editWhatsAppTemplate failed", {
      organizationId,
      templateName: definition.name,
      error: error instanceof Error ? error.message : String(error),
    });
    // Nothing is written locally — the stored row still reflects what Meta
    // actually holds.
    templateRedirect(organizationId, { templateError: message });
  }

  // Only now, after Meta accepted it.
  const db = await getDb();
  await db
    .update(whatsappTemplates)
    .set({
      exampleValues: [exampleValue],
      bodyText: definition.bodyText,
      // An accepted edit re-enters review; the previously approved version
      // keeps sending in the meantime (Meta's own behavior), so this is a
      // truthful "in review", not a service interruption.
      status: "PENDING",
      rejectedReason: null,
      lastEditedAt: new Date(),
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(whatsappTemplates.id, existing.id));

  await recordOwnerAuditEvent({
    eventType: "owner.whatsapp_template_edited",
    description: `תבנית WhatsApp "${definition.label}" עודכנה מול Meta על ידי ${session.email}`,
    severity: "info",
    platformOwnerId: session.platformOwnerId,
    metadata: { organizationId, templateName: definition.name },
  });

  templateRedirect(organizationId, { templateEdited: definition.label });
}
