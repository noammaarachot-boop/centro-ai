import { beforeAll, describe, expect, it } from "vitest";
import { isNotNull, eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { getRequestRequirementNames } from "./documentRequestList";
import { storeWabaConnection } from "./whatsapp/wabaTokens";

// Real DB-integration coverage for the document-collection changes, on an
// ephemeral in-memory PGlite (the same Postgres-in-WASM the app uses for
// local dev) — no shared state, nothing persisted. Proves the behaviors that
// the pure gate/formatter unit tests can't: the requirement snapshot query,
// tenant isolation, the connect default, the column default, and the backfill.

let db: Database;

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

async function seedOrg(name: string, connected: boolean): Promise<string> {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name,
      ...(connected
        ? { whatsappConnectedAt: new Date(), whatsappPhoneNumberId: `pn_${name}` }
        : {}),
    })
    .returning();
  return org.id;
}

async function seedRequestWithRequirements(
  organizationId: string,
  requirementNames: string[]
): Promise<string> {
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId, name: "Test Client", phone: "+972500000000" })
    .returning();
  const [service] = await db
    .insert(schema.services)
    .values({ organizationId, name: "Test Service" })
    .returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId, clientId: client.id, serviceId: service.id, periodLabel: "period" })
    .returning();
  // Insert requirements one at a time so createdAt ordering is deterministic
  // (the snapshot query orders by createdAt).
  for (const name of requirementNames) {
    await db
      .insert(schema.collectionRequestRequirements)
      .values({ collectionRequestId: request.id, name });
  }
  return request.id;
}

describe("column + connect defaults", () => {
  it("defaults documentCollectionEnabled to false for a brand-new organization", async () => {
    const orgId = await seedOrg("fresh-org", false);
    const [org] = await db
      .select({ enabled: schema.organizations.documentCollectionEnabled })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    expect(org.enabled).toBe(false);
  });

  it("storeWabaConnection enables document collection on connect", async () => {
    const orgId = await seedOrg("connecting-org", false);
    await storeWabaConnection(
      orgId,
      {
        businessAccountId: "waba_1",
        phoneNumberId: "pn_1",
        displayPhoneNumber: "+1 555",
        verifiedName: "Biz",
      },
      db
    );
    const [org] = await db
      .select({
        enabled: schema.organizations.documentCollectionEnabled,
        connectedAt: schema.organizations.whatsappConnectedAt,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
    expect(org.enabled).toBe(true);
    expect(org.connectedAt).not.toBeNull();
  });
});

describe("backfill affects only connected organizations", () => {
  it("flips document_collection_enabled to true only where whatsapp is connected", async () => {
    const connectedId = await seedOrg("backfill-connected", true);
    const disconnectedId = await seedOrg("backfill-disconnected", false);

    // Mirrors migration 0031's backfill UPDATE.
    await db
      .update(schema.organizations)
      .set({ documentCollectionEnabled: true })
      .where(isNotNull(schema.organizations.whatsappConnectedAt));

    const rows = await db
      .select({
        id: schema.organizations.id,
        enabled: schema.organizations.documentCollectionEnabled,
      })
      .from(schema.organizations);
    const connected = rows.find((r) => r.id === connectedId);
    const disconnected = rows.find((r) => r.id === disconnectedId);
    expect(connected?.enabled).toBe(true);
    expect(disconnected?.enabled).toBe(false);
  });
});

describe("getRequestRequirementNames — dynamic list from the snapshot", () => {
  it("returns exactly the requirements defined for that request, in order", async () => {
    const orgId = await seedOrg("list-org", true);
    const requestId = await seedRequestWithRequirements(orgId, [
      "תעודת זהות",
      "דפי חשבון בנק",
      "דו״ח תיק השקעות",
    ]);
    const names = await getRequestRequirementNames(orgId, requestId, db);
    expect(names).toEqual(["תעודת זהות", "דפי חשבון בנק", "דו״ח תיק השקעות"]);
  });

  it("reflects a different user's own list — never a hardcoded set", async () => {
    const orgId = await seedOrg("list-org-2", true);
    const requestId = await seedRequestWithRequirements(orgId, [
      "רישיון עסק",
      "חוזה שכירות",
    ]);
    const names = await getRequestRequirementNames(orgId, requestId, db);
    expect(names).toEqual(["רישיון עסק", "חוזה שכירות"]);
  });

  it("never returns another organization's requirements (tenant isolation)", async () => {
    const orgA = await seedOrg("tenant-a", true);
    const orgB = await seedOrg("tenant-b", true);
    const requestA = await seedRequestWithRequirements(orgA, ["מסמך של A"]);
    // Querying org B for org A's request must return nothing.
    const leaked = await getRequestRequirementNames(orgB, requestA, db);
    expect(leaked).toEqual([]);
    // And org A still sees its own.
    const own = await getRequestRequirementNames(orgA, requestA, db);
    expect(own).toEqual(["מסמך של A"]);
  });
});
