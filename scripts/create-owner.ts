/**
 * Internal provisioning tool — the only way a platform_owners row (access
 * to /owner, the internal Owner Dashboard) comes into existence. There is
 * deliberately no self-registration route for this, ever — mirrors
 * scripts/create-organization.ts's own rationale, just for the platform
 * owner instead of a tenant.
 *
 * Usage:
 *   npm run owner:create -- --email owner@example.com --password "…"
 */
import { getDb, migrateDb } from "../src/db";
import { platformOwners } from "../src/db/schema";
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
    console.error('Usage: npm run owner:create -- --email owner@example.com --password "..."');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await migrateDb();
  const db = await getDb();

  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);

  const [owner] = await db
    .insert(platformOwners)
    .values({ email: normalizedEmail, passwordHash })
    .returning({ id: platformOwners.id, email: platformOwners.email });

  await recordOwnerAuditEvent({
    eventType: "owner.created",
    description: `חשבון בעלים נוצר עבור ${owner.email}`,
    severity: "info",
    platformOwnerId: owner.id,
  });

  console.log(`Platform owner created: ${owner.email} (${owner.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to create platform owner:", error);
    process.exit(1);
  });
