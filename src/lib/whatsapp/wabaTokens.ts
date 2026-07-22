import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { organizations } from "@/db/schema";

export interface WabaConnection {
  businessAccountId: string;
  phoneNumberId: string;
  displayPhoneNumber: string;
  verifiedName: string;
}

// No token stored here, unlike driveTokens.ts's encrypted per-org
// access/refresh tokens — the Tech Provider model (see the WhatsApp plan)
// sends/receives for every organization through one shared
// WHATSAPP_SYSTEM_USER_TOKEN, scoped per-call by phoneNumberId. Only
// identifiers live on the organization row.
export async function storeWabaConnection(
  organizationId: string,
  connection: WabaConnection
): Promise<void> {
  const db = await getDb();
  await db
    .update(organizations)
    .set({
      whatsappBusinessAccountId: connection.businessAccountId,
      whatsappPhoneNumberId: connection.phoneNumberId,
      whatsappDisplayPhoneNumber: connection.displayPhoneNumber,
      whatsappVerifiedName: connection.verifiedName,
      whatsappConnectedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
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
      updatedAt: new Date(),
    })
    .where(eq(organizations.id, organizationId));
}
