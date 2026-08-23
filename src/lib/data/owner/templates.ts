import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import { whatsappTemplates } from "@/db/schema";
import {
  DEFAULT_DOCUMENT_LIST_EXAMPLE,
  MANAGED_TEMPLATES,
  describeRejectionReason,
} from "@/lib/whatsapp/templateManagement";

// Read model for the owner screen's "תבניות WhatsApp" area. Deliberately
// returns nothing token-shaped: the organization's access token is read
// only inside the server actions that call Meta, never here, so nothing on
// this path can reach the browser.

export interface OwnerTemplateRow {
  /** Meta template name — also the stable form key for the submit action. */
  name: string;
  label: string;
  language: string;
  category: string;
  bodyText: string;
  /** The example value that will be (or was) sent to Meta for {{1}}. */
  exampleValue: string;
  /**
   * "LOCAL_DRAFT" until submitted; afterwards Meta's own verbatim status
   * (PENDING / APPROVED / REJECTED / PAUSED / ...).
   */
  status: string;
  /** Meta's raw rejected_reason code, null unless rejected. */
  rejectedReason: string | null;
  /** The same reason explained in Hebrew for display. */
  rejectedReasonText: string | null;
  metaTemplateId: string | null;
  lastSyncedAt: Date | null;
  submittedAt: Date | null;
}

// Always returns one row per managed template, whether or not it has been
// submitted yet — the screen shows both templates from the start (with a
// preview and an editable example) rather than only appearing after a
// first submission.
export async function listOwnerTemplates(organizationId: string): Promise<OwnerTemplateRow[]> {
  const db = await getDb();
  const stored = await db
    .select()
    .from(whatsappTemplates)
    .where(eq(whatsappTemplates.organizationId, organizationId));

  return MANAGED_TEMPLATES.map((definition) => {
    const row = stored.find(
      (candidate) => candidate.name === definition.name && candidate.language === definition.language
    );
    const exampleValues = (row?.exampleValues as string[] | undefined) ?? [];

    return {
      name: definition.name,
      label: definition.label,
      language: definition.language,
      // A submitted row's own values win — Meta can reclassify a
      // template's category on review, and the screen must show what Meta
      // actually holds rather than what was originally requested.
      category: row?.category ?? definition.category,
      bodyText: row?.bodyText ?? definition.bodyText,
      exampleValue: exampleValues[0] ?? DEFAULT_DOCUMENT_LIST_EXAMPLE,
      status: row?.status ?? "LOCAL_DRAFT",
      rejectedReason: row?.rejectedReason ?? null,
      rejectedReasonText: describeRejectionReason(row?.rejectedReason ?? null),
      metaTemplateId: row?.metaTemplateId ?? null,
      lastSyncedAt: row?.lastSyncedAt ?? null,
      submittedAt: row?.metaTemplateId ? (row.createdAt ?? null) : null,
    };
  });
}

// Tenant-scoped lookup used by the actions — every query is pinned to the
// organizationId from the request, so one organization's row can never be
// read or written through another's id.
export async function findOrganizationTemplate(organizationId: string, name: string, language: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(whatsappTemplates)
    .where(
      and(
        eq(whatsappTemplates.organizationId, organizationId),
        eq(whatsappTemplates.name, name),
        eq(whatsappTemplates.language, language)
      )
    )
    .limit(1);
  return row ?? null;
}
