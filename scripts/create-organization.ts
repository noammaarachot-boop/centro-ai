/**
 * Internal provisioning tool — the only way a new Organization (and its
 * single shared employee account, EPS BR-13.1) comes into existence.
 * There is deliberately no public signup page; this pilot onboards a
 * handful of firms directly.
 *
 * Usage:
 *   npm run org:create -- --name "Acme CPA" --email admin@acme.co.il --password "…"
 */
import { getDb, migrateDb } from "../src/db";
import { organizations, users } from "../src/db/schema";
import { recordAuditEvent } from "../src/lib/audit";
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
  const { name, email, password } = parseArgs(process.argv.slice(2));

  if (!name || !email || !password) {
    console.error(
      'Usage: npm run org:create -- --name "Firm Name" --email admin@firm.com --password "..."'
    );
    process.exit(1);
  }

  await migrateDb();
  const db = await getDb();

  const passwordHash = await hashPassword(password);

  const [organization] = await db
    .insert(organizations)
    .values({ name })
    .returning({ id: organizations.id, name: organizations.name });

  const [user] = await db
    .insert(users)
    .values({
      organizationId: organization.id,
      email: email.trim().toLowerCase(),
      passwordHash,
    })
    .returning({ id: users.id, email: users.email });

  await recordAuditEvent({
    organizationId: organization.id,
    eventType: "organization.created",
    description: `הארגון "${organization.name}" נוצר עם חשבון גישה משותף (${user.email})`,
    actorType: "system",
  });

  console.log(`Organization created: ${organization.name} (${organization.id})`);
  console.log(`Login: ${user.email}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Failed to create organization:", error);
    process.exit(1);
  });
