import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { getGoogleDriveConnectionStatus } from "./organizations";

// Proves the three real states Settings' Google Drive connection row can
// show, all derived from data that already exists — no new health-check
// infra, no network call to Google. The only signal is the most recent
// integration.google_token_refresh_failed audit event (already written by
// driveAdapter.ts's retry-exhaustion path) compared against the org's own
// googleConnectedAt.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

async function seedOrg(googleConnectedAt: Date | null) {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", googleConnectedAt })
    .returning();
  return org.id;
}

async function seedRefreshFailure(organizationId: string, occurredAt: Date) {
  await db.insert(schema.auditLogs).values({
    organizationId,
    occurredAt,
    eventType: "integration.google_token_refresh_failed",
    actorType: "system",
    description: "Google Drive token refresh failed",
  });
}

describe("getGoogleDriveConnectionStatus", () => {
  it("returns not_connected when googleConnectedAt is null", async () => {
    const orgId = await seedOrg(null);
    expect(await getGoogleDriveConnectionStatus(orgId, null)).toBe("not_connected");
  });

  it("returns connected when connected with no refresh-failure event at all", async () => {
    const connectedAt = new Date("2026-01-01T00:00:00Z");
    const orgId = await seedOrg(connectedAt);
    expect(await getGoogleDriveConnectionStatus(orgId, connectedAt)).toBe("connected");
  });

  it("returns connected when the only refresh failure predates the current connection (stale, already fixed by reconnecting)", async () => {
    const connectedAt = new Date("2026-01-10T00:00:00Z");
    const orgId = await seedOrg(connectedAt);
    await seedRefreshFailure(orgId, new Date("2026-01-05T00:00:00Z"));
    expect(await getGoogleDriveConnectionStatus(orgId, connectedAt)).toBe("connected");
  });

  it("returns needs_reconnect when a refresh failure happened after the current connection was established", async () => {
    const connectedAt = new Date("2026-01-01T00:00:00Z");
    const orgId = await seedOrg(connectedAt);
    await seedRefreshFailure(orgId, new Date("2026-01-15T00:00:00Z"));
    expect(await getGoogleDriveConnectionStatus(orgId, connectedAt)).toBe("needs_reconnect");
  });

  it("picks the most recent failure when several exist, ignoring older ones that predate the connection", async () => {
    const connectedAt = new Date("2026-01-10T00:00:00Z");
    const orgId = await seedOrg(connectedAt);
    await seedRefreshFailure(orgId, new Date("2026-01-02T00:00:00Z")); // before connect — stale
    await seedRefreshFailure(orgId, new Date("2026-01-20T00:00:00Z")); // after connect — live
    expect(await getGoogleDriveConnectionStatus(orgId, connectedAt)).toBe("needs_reconnect");
  });
});
