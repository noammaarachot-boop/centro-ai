import { migrateDb } from "../src/db";
import { assertMigrationsAllowed } from "../src/lib/migrationGuard";

// Checked before opening a connection: a Preview deployment inherits the
// production DATABASE_URL, so this must refuse before it can touch anything.
try {
  assertMigrationsAllowed();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

migrateDb()
  .then(() => {
    console.log("Migrations applied.");
    process.exit(0);
  })
  .catch((error) => {
    console.error("Migration failed:", error);
    process.exit(1);
  });
