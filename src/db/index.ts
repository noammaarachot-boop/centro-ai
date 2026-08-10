import { sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

// Both drivers implement the same PgDatabase query-builder surface; pinning
// the exported type to this common base (instead of letting TypeScript
// infer a union of the two concrete driver types) keeps chained builder
// calls like `.insert(...).returning(...)` fully typed for every caller.
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

interface Connection {
  db: Database;
  migrate: () => Promise<void>;
}

// `db` keeps its precise driver-specific inferred type internally (needed
// so the driver-specific `migrate()` accepts it as-is); only the returned
// `Connection.db` is upcast to the shared `Database` type, which is a safe
// widening in that direction.
async function createPostgresDb(connectionString: string): Promise<Connection> {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { default: postgres } = await import("postgres");
  const client = postgres(connectionString, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, migrate: () => migrate(db, { migrationsFolder: "./drizzle" }) };
}

// ⚠️ PGlite does not support two separate OS processes holding the same
// data directory open at once (documented limitation, confirmed the hard
// way: running a standalone `tsx` script against this same directory while
// `npm run dev` was also running corrupted the on-disk files — every
// subsequent query, including trivial system-catalog lookups, then failed
// with a WASM `RuntimeError: Aborted()`, not a helpful SQL error). If you
// need to run a one-off script (org:create, a debug query, etc.), stop the
// dev server first. If corruption happens again, there is no in-place
// repair — move `.centro-data/pglite` aside and re-run `npm run db:migrate`
// to get a fresh, empty database (this directory is gitignored/local-only,
// so nothing tracked is ever at risk).
async function createPgliteDb(): Promise<Connection> {
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const { PGlite } = await import("@electric-sql/pglite");
  const { mkdir } = await import("node:fs/promises");
  const dataDir = "./.centro-data/pglite";
  await mkdir(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  return { db, migrate: () => migrate(db, { migrationsFolder: "./drizzle" }) };
}

declare global {
  var __centroDb: Promise<Connection> | undefined;
}

/**
 * Production (and any developer who sets DATABASE_URL) talks to a real
 * managed Postgres instance, per EPS DB-8.1 / Ch.19. With no DATABASE_URL
 * set, local development falls back to an embedded PGlite instance (real
 * Postgres compiled to WASM, persisted under .centro-data/) so `npm run dev`
 * works without any local database install. Production requires a real
 * DATABASE_URL — see FR-19.1 / BR-19.1 (dev/prod data isolation).
 */
function initConnection(): Promise<Connection> {
  const connectionString = process.env.DATABASE_URL;

  if (connectionString) {
    return createPostgresDb(connectionString);
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_URL is required in production. Set it to a managed PostgreSQL connection string."
    );
  }

  return createPgliteDb();
}

// Cache the connection across Next.js dev hot-reloads so we don't leak
// connections/PGlite instances on every file change.
function getConnection(): Promise<Connection> {
  if (!global.__centroDb) {
    global.__centroDb = initConnection();
  }
  return global.__centroDb;
}

export async function getDb(): Promise<Database> {
  const { db } = await getConnection();
  return db;
}

// Phase 6.3 (Production Hardening) — migration concurrency safety.
// drizzle's own PgDialect.migrate() reads "last applied migration" and
// only then applies pending ones inside its own transaction, but that
// read happens before any lock is held — two migrate runs racing (two
// overlapping deploys, or a build retried while a prior one is still
// finishing) could both read the same starting point and both attempt to
// apply the same pending migration concurrently. This process-wide
// advisory lock serializes any concurrent attempt: the second one blocks
// until the first fully commits and releases, then migrate() re-reads the
// migrations table itself and correctly finds nothing left to do — never
// double-applies. Exported separately from migrateDb so it can be
// exercised directly against a real PGlite instance in tests, without
// needing to fight the getConnection()/global.__centroDb singleton this
// module otherwise keeps private. Session-scoped pg_advisory_lock (not
// the transaction-scoped pg_advisory_xact_lock used elsewhere in the
// codebase for pooled request-handler connections) is the right choice
// here: this always runs as a single dedicated, non-pooled connection for
// the lifetime of one migration run (a one-off script, or once per cold
// build), so there's no pool-safety hazard, and an explicit unlock in
// `finally` releases it the moment migrate() finishes either way.
export async function withMigrationLock<T>(db: Database, fn: () => Promise<T>): Promise<T> {
  await db.execute(sql`select pg_advisory_lock(hashtext('centro-db-migrate'))`);
  try {
    return await fn();
  } finally {
    await db.execute(sql`select pg_advisory_unlock(hashtext('centro-db-migrate'))`);
  }
}

export async function migrateDb() {
  const { db, migrate } = await getConnection();
  await withMigrationLock(db, migrate);
}
