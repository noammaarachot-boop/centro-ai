import * as schema from "@/db/schema";
import { MANAGED_TEMPLATES } from "@/lib/whatsapp/templateManagement";
import type { Database } from "@/db";

/**
 * Gives an organization the approved templates a real send now requires.
 *
 * Sending is resolved per organization: the send path asks for this office's
 * own APPROVED template for a business intent (DOCUMENT_REQUEST /
 * DOCUMENT_REMINDER) on its own WABA. Before that, it asked Meta for a
 * hardcoded name gated on a hand-set boolean, so a fixture only had to set a
 * phone number id for a send to be attempted.
 *
 * Tests that assert a send happens therefore have to seed the templates that
 * make one legal — which is the point: an office with no approved template
 * genuinely cannot send, and a test that skipped this step was asserting
 * behaviour production could never reproduce.
 */
export async function seedApprovedWhatsAppTemplates(
  db: Database,
  organizationId: string,
  wabaId = "waba-test"
): Promise<void> {
  for (const definition of MANAGED_TEMPLATES) {
    await db
      .insert(schema.whatsappTemplates)
      .values({
        organizationId,
        wabaId,
        intent: definition.intent,
        name: definition.name,
        language: definition.language,
        category: definition.category,
        bodyText: definition.bodyText,
        variables: ["{{1}}"],
        exampleValues: ["תעודת זהות, דפי בנק"],
        metaTemplateId: `meta-${definition.intent.toLowerCase()}`,
        status: "APPROVED",
        lastSyncedAt: new Date(),
      })
      .onConflictDoNothing();
  }
}
