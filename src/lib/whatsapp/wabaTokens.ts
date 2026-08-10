import { eq } from "drizzle-orm";
import { getDb, type Database } from "@/db";
import { organizations } from "@/db/schema";
import { isUniqueViolation } from "@/lib/db/errors";

export interface WabaConnection {
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
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

// No token stored here, unlike driveTokens.ts's encrypted per-org
// access/refresh tokens — the Tech Provider model (see the WhatsApp plan)
// sends/receives for every organization through one shared
// WHATSAPP_SYSTEM_USER_TOKEN, scoped per-call by phoneNumberId. Only
// identifiers live on the organization row.
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
// guarantee. No token to revoke with Meta (nothing per-org was ever
// issued), so this is a pure local clear.
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
      // No connected WhatsApp ⇒ automated document collection cannot run;
      // clear the gate so a later reconnect re-enables it deliberately.
      documentCollectionEnabled: false,
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}
