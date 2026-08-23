/**
 * H2 — the seven multi-tenant read indexes, created out of band.
 *
 * These are declared in schema.ts, but migration 0072 deliberately creates
 * nothing: drizzle-orm 0.45.2 runs every migration inside one transaction
 * and offers no per-migration opt-out, and CREATE INDEX CONCURRENTLY inside
 * a transaction is rejected by Postgres (SQLSTATE 25001). A plain
 * CREATE INDEX would work but takes a lock that blocks writes for the
 * duration — tolerable at today's row counts, not at tomorrow's.
 *
 * So they are created here instead, CONCURRENTLY, which takes only
 * SHARE UPDATE EXCLUSIVE and never blocks reads or writes.
 *
 * The logic lives in this module rather than in the script so it can be
 * tested against a real Postgres (PGlite) — including the failure paths,
 * which are the ones that actually matter.
 */

/** Ordered exactly as they are created. Names must match schema.ts. */
export const H2_INDEXES = [
  {
    name: "audit_logs_organization_id_occurred_at_idx",
    table: "audit_logs",
    columns: `"organization_id","occurred_at" DESC NULLS LAST`,
  },
  {
    name: "collection_requests_organization_id_status_idx",
    table: "collection_requests",
    columns: `"organization_id","status"`,
  },
  {
    name: "conversations_organization_id_status_idx",
    table: "conversations",
    columns: `"organization_id","status"`,
  },
  {
    name: "conversations_collection_request_id_idx",
    table: "conversations",
    columns: `"collection_request_id"`,
  },
  {
    name: "documents_collection_request_id_idx",
    table: "documents",
    columns: `"collection_request_id"`,
  },
  {
    name: "messages_organization_id_direction_delivery_status_idx",
    table: "messages",
    columns: `"organization_id","direction","delivery_status"`,
  },
  {
    name: "messages_conversation_id_created_at_idx",
    table: "messages",
    columns: `"conversation_id","created_at"`,
  },
] as const;

/**
 * Runs one statement in autocommit and returns rows. Deliberately minimal:
 * the caller owns the connection, so this module cannot open a transaction
 * (which would break CONCURRENTLY) or connect anywhere on its own.
 */
export type SqlExecutor = (statement: string) => Promise<Array<Record<string, unknown>>>;

export type IndexOutcome = "created" | "skipped" | "recreated_after_invalid";

export interface IndexResult {
  name: string;
  outcome: IndexOutcome;
}

export class IndexCreationError extends Error {
  constructor(
    readonly indexName: string,
    readonly cause: unknown
  ) {
    super(`Failed to create index "${indexName}": ${(cause as Error)?.message ?? cause}`);
    this.name = "IndexCreationError";
  }
}

/** null when no index of that name exists. */
async function inspectIndex(
  exec: SqlExecutor,
  name: string
): Promise<{ valid: boolean } | null> {
  const rows = await exec(`
    select i.indisvalid, i.indisready
    from pg_class c
    join pg_index i on i.indexrelid = c.oid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = '${name}'
  `);
  if (rows.length === 0) return null;
  // Both flags must hold: a half-built index can be "valid" but not yet
  // "ready", and neither state is usable by the planner.
  return { valid: Boolean(rows[0].indisvalid) && Boolean(rows[0].indisready) };
}

/**
 * Creates all seven indexes, in order, one at a time.
 *
 * Per index:
 *   • absent               → create
 *   • present and valid    → skip (this is what makes reruns free)
 *   • present but INVALID  → drop that one index, then recreate
 *
 * The INVALID case is the reason this cannot be a plain script of seven
 * CREATE INDEX CONCURRENTLY IF NOT EXISTS lines. A failed CONCURRENTLY
 * build leaves an INVALID index behind; IF NOT EXISTS then sees the name is
 * taken and silently skips it forever, leaving an index the planner refuses
 * to use but every INSERT still has to maintain. It has to be detected and
 * replaced explicitly.
 *
 * Stops at the first failure — a later index's success would otherwise hide
 * an earlier one's failure in the summary.
 */
export async function ensureH2Indexes(
  exec: SqlExecutor,
  log: (message: string) => void = () => {}
): Promise<IndexResult[]> {
  const results: IndexResult[] = [];

  for (const [position, index] of H2_INDEXES.entries()) {
    const label = `[${position + 1}/${H2_INDEXES.length}] ${index.name}`;
    const existing = await inspectIndex(exec, index.name);

    if (existing?.valid) {
      log(`${label}: already present and valid — skipping`);
      results.push({ name: index.name, outcome: "skipped" });
      continue;
    }

    let outcome: IndexOutcome = "created";
    if (existing && !existing.valid) {
      // Scoped to this exact index, by name. Never a blanket drop, and
      // never an index this module did not declare.
      log(`${label}: present but INVALID (leftover from a failed build) — dropping it`);
      await exec(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
      outcome = "recreated_after_invalid";
    }

    log(`${label}: creating…`);
    try {
      await exec(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${index.name}" ` +
          `ON "${index.table}" USING btree (${index.columns})`
      );
    } catch (error) {
      throw new IndexCreationError(index.name, error);
    }

    // CREATE INDEX CONCURRENTLY can report success and still leave an
    // unusable index, so trust pg_index rather than the absence of a throw.
    const after = await inspectIndex(exec, index.name);
    if (!after?.valid) {
      throw new IndexCreationError(
        index.name,
        new Error("index exists but is not valid/ready after creation")
      );
    }

    log(`${label}: ${outcome === "recreated_after_invalid" ? "recreated" : "created"}`);
    results.push({ name: index.name, outcome });
  }

  return results;
}

/** Independent final check — re-reads every index rather than trusting the run. */
export async function verifyH2Indexes(
  exec: SqlExecutor
): Promise<{ ok: boolean; missing: string[]; invalid: string[] }> {
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const index of H2_INDEXES) {
    const state = await inspectIndex(exec, index.name);
    if (!state) missing.push(index.name);
    else if (!state.valid) invalid.push(index.name);
  }

  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid };
}
