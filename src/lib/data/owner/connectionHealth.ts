import { sql } from "drizzle-orm";
import { getDb } from "@/db";

// The passive WhatsApp signal behind "דורש טיפול": how many outbound sends
// have failed since the last one that actually succeeded.
//
// Computed as "failures newer than the newest success" rather than by
// walking rows, which is what makes it self-healing for free — one
// successful send moves the cutoff forward and the count collapses to 0,
// with no flag to clear and no historical failure left pinning the
// organization red.
export interface OrganizationSendFailureSignal {
  consecutiveSendFailures: number;
  lastSuccessfulSendAt: Date | null;
}

export async function getSendFailureSignals(): Promise<Map<string, OrganizationSendFailureSignal>> {
  const db = await getDb();

  const rows = await db.execute<{
    organization_id: string;
    consecutive_failures: number;
    last_success_at: Date | null;
  }>(sql`
    with last_success as (
      select organization_id, max(created_at) as at
      from messages
      where direction = 'outbound' and delivery_status = 'sent'
      group by organization_id
    )
    select
      m.organization_id,
      count(*) filter (
        where m.delivery_status = 'failed'
          and (ls.at is null or m.created_at > ls.at)
      )::int as consecutive_failures,
      ls.at as last_success_at
    from messages m
    left join last_success ls on ls.organization_id = m.organization_id
    where m.direction = 'outbound'
    group by m.organization_id, ls.at
  `);

  // db.execute's shape differs between the postgres-js and PGlite drivers
  // (array vs { rows }); both are handled the same way elsewhere in this
  // codebase (see owner/health.ts's callers).
  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []);

  const map = new Map<string, OrganizationSendFailureSignal>();
  for (const row of list as Array<{
    organization_id: string;
    consecutive_failures: number;
    last_success_at: Date | string | null;
  }>) {
    map.set(row.organization_id, {
      consecutiveSendFailures: Number(row.consecutive_failures ?? 0),
      lastSuccessfulSendAt: row.last_success_at ? new Date(row.last_success_at) : null,
    });
  }
  return map;
}

/**
 * The same signal as above, for a single organization.
 *
 * Scoped in SQL rather than by computing every tenant's signal and picking
 * one out of the result: this runs on every load of an organization's page,
 * and the all-tenants form made that page's cost grow with the size of the
 * whole platform. Filtering here also means no other tenant's messages are
 * read to answer a question about this one.
 *
 * Both the CTE and the count filter on
 * (organization_id, direction, delivery_status) — the column order of
 * messages_organization_id_direction_delivery_status_idx.
 */
export async function getSendFailureSignal(
  organizationId: string
): Promise<OrganizationSendFailureSignal> {
  const db = await getDb();

  const rows = await db.execute<{
    consecutive_failures: number;
    last_success_at: Date | null;
  }>(sql`
    with last_success as (
      select max(created_at) as at
      from messages
      where organization_id = ${organizationId}
        and direction = 'outbound'
        and delivery_status = 'sent'
    )
    select
      ls.at as last_success_at,
      (
        select count(*)
        from messages m
        where m.organization_id = ${organizationId}
          and m.direction = 'outbound'
          and m.delivery_status = 'failed'
          and (ls.at is null or m.created_at > ls.at)
      )::int as consecutive_failures
    from last_success ls
  `);

  const list = Array.isArray(rows)
    ? rows
    : ((rows as unknown as { rows: Array<Record<string, unknown>> }).rows ?? []);

  const row = (list as Array<{
    consecutive_failures: number;
    last_success_at: Date | string | null;
  }>)[0];

  // last_success is a bare aggregate, so it yields exactly one row even for
  // an organization with no messages at all — but an absent row still falls
  // back to the same "nothing has failed" answer the map lookup gave.
  if (!row) return { consecutiveSendFailures: 0, lastSuccessfulSendAt: null };

  return {
    consecutiveSendFailures: Number(row.consecutive_failures ?? 0),
    lastSuccessfulSendAt: row.last_success_at ? new Date(row.last_success_at) : null,
  };
}
