import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import * as schema from "./schema";
import {
  H2_INDEXES,
  ensureH2Indexes,
  verifyH2Indexes,
  IndexCreationError,
  type SqlExecutor,
} from "./indexMaintenance";

// Exercises the out-of-band index creation against a real Postgres engine
// (PGlite is Postgres compiled to WASM, not an emulation), including the
// failure paths — which are the whole reason this is not seven lines of
// CREATE INDEX CONCURRENTLY IF NOT EXISTS in a shell script.

let db: ReturnType<typeof drizzle>;
let exec: SqlExecutor;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db as never, { migrationsFolder: "./drizzle" });
  await db.execute(sql`select 1`);
  exec = async (statement: string) => {
    const res = await db.execute(sql.raw(statement));
    return (Array.isArray(res) ? res : ((res as never as { rows: never[] }).rows ?? [])) as Array<
      Record<string, unknown>
    >;
  };
}, 60_000);

async function indexState(name: string) {
  const rows = await exec(`
    select i.indisvalid from pg_class c
    join pg_index i on i.indexrelid = c.oid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = '${name}'
  `);
  return rows.length === 0 ? null : { valid: Boolean(rows[0].indisvalid) };
}

describe("migration 0072 is a genuine no-op", () => {
  // The migration applied in beforeAll must have created none of these:
  // that is the property that keeps the deploy lock-free, and if a future
  // edit puts the DDL back into 0072 this test is what catches it.
  it("leaves all seven indexes absent after migrations alone", async () => {
    const verification = await verifyH2Indexes(exec);
    expect(verification.ok).toBe(false);
    expect(verification.missing).toHaveLength(H2_INDEXES.length);
    expect(verification.invalid).toHaveLength(0);
  });
});

describe("ensureH2Indexes", () => {
  it("first run creates all seven and they are valid", async () => {
    const results = await ensureH2Indexes(exec);

    expect(results).toHaveLength(7);
    expect(results.every((r) => r.outcome === "created")).toBe(true);

    const verification = await verifyH2Indexes(exec);
    expect(verification).toEqual({ ok: true, missing: [], invalid: [] });
  });

  // Idempotency: the operator must be able to re-run without thinking about
  // whether a previous attempt got partway.
  it("second run skips all seven and still succeeds", async () => {
    const results = await ensureH2Indexes(exec);

    expect(results).toHaveLength(7);
    expect(results.every((r) => r.outcome === "skipped")).toBe(true);
    expect((await verifyH2Indexes(exec)).ok).toBe(true);
  });

  it("creates only the missing ones when a run got partway", async () => {
    // Simulate an interrupted run: three of the seven never got built.
    const dropped: string[] = H2_INDEXES.slice(0, 3).map((i) => i.name);
    for (const name of dropped) await exec(`DROP INDEX IF EXISTS "${name}"`);

    const results = await ensureH2Indexes(exec);

    for (const r of results) {
      expect(r.outcome).toBe(dropped.includes(r.name) ? "created" : "skipped");
    }
    expect((await verifyH2Indexes(exec)).ok).toBe(true);
  });

  // The trap this module exists to avoid. A failed CONCURRENTLY build
  // leaves an INVALID index; IF NOT EXISTS would then skip that name
  // forever, leaving an index the planner will not use but every write
  // still maintains.
  it("detects an INVALID index and rebuilds it instead of skipping", async () => {
    const target = H2_INDEXES[5].name; // the messages composite
    // Fault injection: mark it invalid exactly as an aborted build would.
    // Only possible because PGlite runs as superuser — never done anywhere
    // near a real database.
    await exec(`update pg_index set indisvalid = false
                where indexrelid = '${target}'::regclass`);
    expect(await indexState(target)).toEqual({ valid: false });

    const results = await ensureH2Indexes(exec);

    const repaired = results.find((r) => r.name === target);
    expect(repaired?.outcome).toBe("recreated_after_invalid");
    // Every other index was left alone.
    expect(results.filter((r) => r.outcome === "skipped")).toHaveLength(6);

    expect(await indexState(target)).toEqual({ valid: true });
    expect((await verifyH2Indexes(exec)).ok).toBe(true);
  });

  it("stops at the first failure rather than continuing", async () => {
    // A definition pointing at a column that does not exist — the shape of
    // any real DDL failure.
    const broken: SqlExecutor = async (statement) => {
      if (statement.includes(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${H2_INDEXES[1].name}"`)) {
        throw new Error(`column "nope" does not exist`);
      }
      return exec(statement);
    };
    // Force index 1 to be attempted by removing it first.
    await exec(`DROP INDEX IF EXISTS "${H2_INDEXES[1].name}"`);

    await expect(ensureH2Indexes(broken)).rejects.toBeInstanceOf(IndexCreationError);
    await expect(ensureH2Indexes(broken)).rejects.toMatchObject({
      indexName: H2_INDEXES[1].name,
    });

    // Restore for any later test.
    await ensureH2Indexes(exec);
    expect((await verifyH2Indexes(exec)).ok).toBe(true);
  });

  it("touches no index it does not declare", async () => {
    const declared = new Set<string>(H2_INDEXES.map((i) => i.name));
    const before = await exec(`
      select c.relname from pg_class c
      join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' order by c.relname
    `);
    const foreignBefore = before.map((r) => r.relname).filter((n) => !declared.has(n as string));

    await ensureH2Indexes(exec);

    const after = await exec(`
      select c.relname from pg_class c
      join pg_index i on i.indexrelid = c.oid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' order by c.relname
    `);
    const foreignAfter = after.map((r) => r.relname).filter((n) => !declared.has(n as string));

    // Every pre-existing index — primary keys, the unique indexes that
    // enforce real business constraints — is exactly as it was.
    expect(foreignAfter).toEqual(foreignBefore);
    expect(foreignBefore.length).toBeGreaterThan(0);
  });
});

describe("H2_INDEXES matches what schema.ts declares", () => {
  // If someone adds an index to schema.ts and regenerates, this list has to
  // grow with it, or the new index silently never gets created in an
  // environment provisioned from scratch.
  it("covers exactly the seven index names in the H2 set", () => {
    expect(H2_INDEXES.map((i) => i.name).sort()).toEqual(
      [
        "audit_logs_organization_id_occurred_at_idx",
        "collection_requests_organization_id_status_idx",
        "conversations_collection_request_id_idx",
        "conversations_organization_id_status_idx",
        "documents_collection_request_id_idx",
        "messages_conversation_id_created_at_idx",
        "messages_organization_id_direction_delivery_status_idx",
      ].sort()
    );
  });
});
