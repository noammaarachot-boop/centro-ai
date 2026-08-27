import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { organizations } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db/errors";
import { encryptWhatsAppToken } from "./tokenCipher";

export interface WabaConnection {
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  // Manual per-organization connection only (owner-only, /owner/
  // organizations/[id]) — never set by the Embedded Signup flow, which
  // keeps relying on the shared WHATSAPP_SYSTEM_USER_TOKEN exactly as
  // before. Encrypted before it ever reaches the database — see
  // tokenCipher.ts.
  accessToken?: string;
  // Manual connections only — the per-phone-number webhook override's
  // handshake token (webhookUrls.ts). Written BEFORE the override is
  // registered with Meta, since Meta GET-handshakes the override URL
  // during that call and the dynamic route answers it from this column.
  // Null for every Embedded Signup organization, which has no override and
  // keeps receiving events on the shared app-level endpoint.
  webhookVerifyToken?: string;
}

// Thrown by storeWabaConnection when this WABA/phone number is already
// connected to a DIFFERENT organization (the DB-level backstop — see
// organizations_whatsapp_phone_number_id_idx / _business_account_id_idx,
// Phase 1.6 remediation). A clear, catchable error instead of a raw
// Postgres unique-violation bubbling up — completeWhatsAppSignup
// (src/lib/whatsapp/completeSignup.ts) already wraps any error thrown at
// the "store" step into a WhatsAppSignupError, so this only needs to carry
// a message worth showing.
export class WhatsAppConnectionConflictError extends Error {}

// Embedded-Signup connections never pass `connection.accessToken` (no
// token stored — see the WhatsApp plan: one shared
// WHATSAPP_SYSTEM_USER_TOKEN sends/receives for every such organization,
// scoped per-call by phoneNumberId) — this stays exactly as before for
// them, only identifiers on the organization row. Manual per-organization
// connections (owner-only) additionally pass `accessToken`, encrypted here
// before the write.
export async function storeWabaConnection(
  organizationId: string,
  connection: WabaConnection,
  // Optional injection point for tests (in-memory PGlite).
  dbOverride?: Database
): Promise<void> {
  const db = dbOverride ?? (await getDb());
  try {
    await db
      .update(organizations)
      .set({
        whatsappBusinessAccountId: connection.businessAccountId,
        whatsappPhoneNumberId: connection.phoneNumberId,
        whatsappDisplayPhoneNumber: connection.displayPhoneNumber,
        whatsappVerifiedName: connection.verifiedName,
        whatsappConnectedAt: new Date(),
        ...(connection.accessToken ? { whatsappAccessTokenEnc: encryptWhatsAppToken(connection.accessToken) } : {}),
        ...(connection.webhookVerifyToken ? { whatsappWebhookVerifyToken: connection.webhookVerifyToken } : {}),
        // Automated document collection is on by default the moment WhatsApp
        // finishes connecting (product decision) — no separate activation
        // step, and the user can still turn it off from Settings.
        documentCollectionEnabled: true,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organizationId));
  } catch (error) {
    if (
      isUniqueViolation(error, "organizations_whatsapp_phone_number_id_idx") ||
      isUniqueViolation(error, "organizations_whatsapp_business_account_id_idx")
    ) {
      throw new WhatsAppConnectionConflictError(
        "מספר ה-WhatsApp הזה כבר מחובר לארגון אחר במערכת. יש לנתק אותו משם קודם, או לפנות לתמיכה."
      );
    }
    throw error;
  }
}

// Disconnect: clear every stored identifier — mirrors clearTokens'
// (googleAuth/driveTokens.ts) "nothing left to act on after this"
// guarantee. No token to revoke with Meta for an Embedded-Signup
// connection (nothing per-org was ever issued); a manual connection's own
// encrypted token is simply cleared locally the same way — Meta itself
// doesn't require or offer a "revoke" call for this kind of System User
// token from Centro's side.
export async function clearWabaConnection(organizationId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(organizations)
    .set({
      whatsappBusinessAccountId: null,
      whatsappPhoneNumberId: null,
      whatsappDisplayPhoneNumber: null,
      whatsappVerifiedName: null,
      whatsappConnectedAt: null,
      whatsappAccessTokenEnc: null,
      whatsappWebhookVerifyToken: null,
      // No connected WhatsApp ⇒ automated document collection cannot run;
      // clear the gate so a later reconnect re-enables it deliberately.
      documentCollectionEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}

/**
 * Records whether Centro's Meta App is verified as subscribed to this
 * organization's WABA.
 *
 * Stored per organization so the owner screen can say "webhook ready" only
 * when it has actually been read back from Meta — never inferred from a
 * subscribe call that may have attached a different app.
 */
export async function recordWebhookSubscriptionState(
  organizationId: string,
  subscribed: boolean
): Promise<void> {
  const db = await getDb();
  await db
    .update(organizations)
    .set({
      whatsappWebhookSubscribedAt: subscribed ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}
