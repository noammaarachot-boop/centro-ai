import { getOrganization } from "@/lib/data/organizations";
import { getValidAccessToken, GoogleNotConnectedError } from "@/lib/googleAuth/driveTokens";

export interface IntegrationStatus {
  whatsappReady: boolean;
  driveReady: boolean;
}

// Exact wording requested by the product owner — shown wherever a
// collection is about to be started (never a generic error), with a
// concrete action to fix it right next to it.
export const WHATSAPP_NOT_READY_MESSAGE =
  "לא ניתן להתחיל את האיסוף. חיבור ה-WhatsApp אינו פעיל. יש לחבר מחדש את WhatsApp כדי להתחיל.";
export const DRIVE_NOT_READY_MESSAGE =
  "לא ניתן להתחיל את האיסוף. חיבור ה-Google Drive אינו פעיל. יש לחבר מחדש את Google Drive כדי להתחיל.";

/**
 * Product Evolution M9 ("WhatsApp and Google Drive are mandatory") — the
 * one place that answers "can this organization actually run a collection
 * right now," verified live rather than trusted from a stored timestamp
 * alone ("simply clicking Connect is not enough").
 *
 * WhatsApp has no per-organization token to refresh — Centro is a Meta
 * Tech Provider, sending through one shared System User token scoped by
 * whatsappPhoneNumberId (see organizations' own schema comment) — so
 * "ready" is both identifiers Meta handed back at connect time still being
 * present; there is nothing further to ping without sending a real
 * message.
 *
 * Google Drive gets a genuine live check: getValidAccessToken
 * (src/lib/googleAuth/driveTokens.ts) actually attempts a token refresh
 * when the stored one is expiring and throws GoogleNotConnectedError if
 * that fails — so this catches a revoked/expired connection, not merely
 * "was connected at some point."
 */
export async function checkIntegrationStatus(organizationId: string): Promise<IntegrationStatus> {
  const organization = await getOrganization(organizationId);
  const whatsappReady = !!(organization?.whatsappConnectedAt && organization?.whatsappPhoneNumberId);

  let driveReady = false;
  if (organization?.googleConnectedAt && organization?.googleDriveFolderId) {
    try {
      await getValidAccessToken(organizationId);
      driveReady = true;
    } catch (error) {
      if (!(error instanceof GoogleNotConnectedError)) {
        console.error("[integrations] Drive verification failed unexpectedly", error);
      }
      driveReady = false;
    }
  }

  return { whatsappReady, driveReady };
}
