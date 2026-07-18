import * as schema from "./schema";

async function createPostgresDb(connectionString: string) {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const { default: postgres } = await import("postgres");
  const client = postgres(connectionString, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, migrate: () => migrate(db, { migrationsFolder: "./drizzle" }) };
}

async function createPgliteDb() {
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

type Connection = Awaited<ReturnType<typeof createPostgresDb | typeof createPgliteDb>>;

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

export async function getDb() {
  const { db } = await getConnection();
  return db;
}

export async function migrateDb() {
  const { migrate } = await getConnection();
  await migrate();
}
