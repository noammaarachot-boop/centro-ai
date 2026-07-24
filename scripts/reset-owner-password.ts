/**
 * Recovery tool for the platform owner's own login — deliberately a CLI
 * script rather than the full email-based forgot-password flow the
 * customer-facing app has (src/app/forgot-password/), which would be
 * overkill for exactly one account. Also revokes every existing owner
 * session, matching the "a password reset should invalidate old sessions"
 * expectation.
 *
 * Usage:
 *   npm run owner:reset-password -- --email owner@example.com --password "…"
 */
import { eq } from "drizzle-orm";
import { getDb, migrateDb } from "../src/db";
import { platformOwners, platformOwnerSessions } from "../src/db/schema";
import { recordOwnerAuditEvent } from "../src/lib/owner/audit";
import { hashPassword } from "../src/lib/auth/password";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      args[key] = value ?? "";
      i += 1;
    }
  }
  return args;
}

async function main() {
  const { email, password } = parseArgs(process.argv.slice(2));

  if (!email || !password) {
    console.error(
      'Usage: npm run owner:reset-password -- --email owner@example.com --password "..."'
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await migrateDb();
  const db = await getDb();

  const normalizedEmail = email.trim().toLowerCase();
  const [owner] = await db
    .select()
    .from(platformOwners)
    .where(eq(platformOwners.email, normalizedEmail))
    .limit(1);

  if (!owner) {
    console.error(`No platform owner found for ${normalizedEmail}`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  await db
    .update(platformOwners)
    .set({ passwordHash })
    .where(eq(platformOwners.id, owner.id));

  await db.delete(platformOwnerSessions).where(eq(platformOwnerSessions.platformOwnerId, owner.id));

  await recordOwnerAuditEvent({
    eventType: "owner.password_reset",
    description: `הסיסמה אופסה עבור ${owner.email} (כל הפעלות הבעלים בוטלו)`,
    severity: "warning",
    platformOwnerId: owner.id,
  });

  console.log(`Password reset for ${owner.email}. All existing owner sessions were revoked.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to reset platform owner password:", error);
    process.exit(1);
  });
