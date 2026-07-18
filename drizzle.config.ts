import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Only used by `drizzle-kit generate` for dialect-specific SQL
    // generation; it does not open a connection. Local dev applies
    // migrations at runtime via src/db/index.ts instead (see migrateDb).
    url: process.env.DATABASE_URL ?? "postgres://unused:unused@localhost:5432/unused",
  },
});
