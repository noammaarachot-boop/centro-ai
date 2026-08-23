/**
 * Creates the seven H2 indexes on a live database, CONCURRENTLY.
 *
 * Usage:
 *   DATABASE_URL="postgres://…" npm run db:create-indexes -- --confirm <dbname>
 *
 * Safe to run repeatedly: an index that is already present and valid is
 * skipped. See src/db/indexMaintenance.ts for the per-index logic.
 *
 * Two deliberate guards against hitting the wrong database:
 *
 *   1. It NEVER uses src/db's getDb(). That helper falls back to a local
 *      PGlite file when DATABASE_URL is unset, so a script built on it
 *      would happily "create" all seven indexes in .centro-data/ and report
 *      success while production was untouched. This connects directly and
 *      refuses to start without an explicit DATABASE_URL.
 *
 *   2. --confirm must match the database's own current_database(). Knowing
 *      the target's name is the one thing an accidental run does not have.
 */
import postgres from "postgres";
import {
  ensureH2Indexes,
  verifyH2Indexes,
  IndexCreationError,
  H2_INDEXES,
} from "../src/db/indexMaintenance";

function parseConfirm(argv: string[]): string | null {
  const i = argv.indexOf("--confirm");
  if (i === -1) return null;
  return argv[i + 1] ?? null;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      "DATABASE_URL is not set. Refusing to run — this script must never\n" +
        "fall back to a local database and report success against it."
    );
    process.exit(1);
  }

  // max: 1 keeps it strictly serial. prepare: false keeps each statement a
  // plain autocommit simple query, which is what CONCURRENTLY requires —
  // postgres.js never opens a transaction unless sql.begin() is called, and
  // it is not called anywhere in this script.
  const sql = postgres(connectionString, { max: 1, prepare: false });

  try {
    const [identity] = await sql`
      select current_database() as db, current_user as usr,
             inet_server_addr()::text as host, version() as version
    `;

    // Never print the connection string — it carries credentials.
    console.log("Target database");
    console.log(`  database : ${identity.db}`);
    console.log(`  user     : ${identity.usr}`);
    console.log(`  host     : ${identity.host ?? "(local socket)"}`);
    console.log(`  version  : ${String(identity.version).split(",")[0]}`);
    console.log("");

    const confirm = parseConfirm(process.argv.slice(2));
    if (confirm !== identity.db) {
      console.error(
        confirm === null
          ? `Refusing to run without confirmation.\nRe-run with:  --confirm ${identity.db}`
          : `Confirmation mismatch: you passed "${confirm}", but this connection is to "${identity.db}".\nRefusing to run.`
      );
      process.exit(1);
    }

    // `simple: true` is load-bearing, not decoration.
    //
    // In the extended query protocol the Parse/Bind/Execute/Sync sequence is
    // an implicit transaction block, and CREATE INDEX CONCURRENTLY inside one
    // fails with SQLSTATE 25001 — the exact error this whole approach exists
    // to avoid. postgres.js happens to default to the simple protocol when a
    // query has no parameters, so omitting this would work today and break
    // the moment anyone gave one of these statements a bind parameter.
    // Stating it explicitly makes that failure impossible.
    const executor = async (statement: string) =>
      (await sql.unsafe(statement).simple()) as unknown as Array<Record<string, unknown>>;

    console.log(`Creating ${H2_INDEXES.length} indexes CONCURRENTLY (one at a time)…\n`);
    const results = await ensureH2Indexes(executor, (m) => console.log(`  ${m}`));

    console.log("\nVerifying…");
    const verification = await verifyH2Indexes(executor);
    if (!verification.ok) {
      console.error("VERIFICATION FAILED");
      if (verification.missing.length) console.error(`  missing: ${verification.missing.join(", ")}`);
      if (verification.invalid.length) console.error(`  invalid: ${verification.invalid.join(", ")}`);
      process.exit(1);
    }

    const created = results.filter((r) => r.outcome === "created").length;
    const skipped = results.filter((r) => r.outcome === "skipped").length;
    const repaired = results.filter((r) => r.outcome === "recreated_after_invalid").length;
    console.log(
      `\nAll ${H2_INDEXES.length} indexes present and valid. ` +
        `(created: ${created}, skipped: ${skipped}, repaired: ${repaired})`
    );
  } catch (error) {
    if (error instanceof IndexCreationError) {
      console.error(`\nFAILED on index: ${error.indexName}`);
      console.error(`  ${(error.cause as Error)?.message ?? error.cause}`);
      console.error(
        "\nStopped without attempting the remaining indexes.\n" +
          "Re-running is safe: indexes already built are skipped, and a\n" +
          "leftover INVALID index from this failure is dropped and rebuilt."
      );
    } else {
      console.error("\nFAILED:", (error as Error)?.message ?? error);
    }
    process.exit(1);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
