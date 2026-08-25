import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { hasSentAnyOnDemandRequest, resolveOnDemandDraft } from "./collectionRequestDrafts";

// Repeat-use rework — hasSentAnyOnDemandRequest now also drives WhatStep's
// first-vs-subsequent-request UI branch (isFirstRequest, computed in
// collections/new/page.tsx). resolveOnDemandDraft itself stays scoped to
// its one original, unambiguous caller (the Google OAuth return path) —
// an audit during this same rework found that resolving it for every
// plain "/collections/new" hit can't distinguish a genuinely abandoned
// wizard draft from a deliberately-built, not-yet-sent Template
// (duplicateTemplate produces the exact same on_demand/zero-requests
// shape without ever touching the wizard), so that broader use was
// reverted. Both functions themselves are unchanged — this file exists
// because hasSentAnyOnDemandRequest is now load-bearing for a second call
// site, and neither had dedicated coverage of its own yet.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

async function seedOrg() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  return org.id;
}

async function seedOnDemandService(organizationId: string, name = "Draft") {
  const [service] = await db
    .insert(schema.services)
    .values({ organizationId, name, collectionMode: "on_demand" })
    .returning();
  return service.id;
}

async function seedClient(organizationId: string) {
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  return client.id;
}

async function markSent(organizationId: string, serviceId: string) {
  const clientId = await seedClient(organizationId);
  await db.insert(schema.collectionRequests).values({
    organizationId,
    clientId,
    serviceId,
    periodLabel: "test",
    status: "active",
  });
}

describe("resolveOnDemandDraft", () => {
  it("returns null when the org has no on-demand service at all", async () => {
    const orgId = await seedOrg();
    expect(await resolveOnDemandDraft(orgId)).toBeNull();
  });

  it("returns the on-demand service's id when it has never been sent (zero collection_requests)", async () => {
    const orgId = await seedOrg();
    const serviceId = await seedOnDemandService(orgId);
    expect(await resolveOnDemandDraft(orgId)).toBe(serviceId);
  });

  it("returns null once that same service has been sent at least once — nothing left to resume", async () => {
    const orgId = await seedOrg();
    const serviceId = await seedOnDemandService(orgId);
    await markSent(orgId, serviceId);
    expect(await resolveOnDemandDraft(orgId)).toBeNull();
  });

  it("with several on-demand services, resolves specifically the one that's still unsent", async () => {
    const orgId = await seedOrg();
    const sentServiceId = await seedOnDemandService(orgId, "Already sent");
    await markSent(orgId, sentServiceId);
    const draftServiceId = await seedOnDemandService(orgId, "Still a draft");

    expect(await resolveOnDemandDraft(orgId)).toBe(draftServiceId);
  });

  it("never a recurring service, even if it's somehow never been sent to", async () => {
    const orgId = await seedOrg();
    await db.insert(schema.services).values({ organizationId: orgId, name: "Recurring", collectionMode: "recurring" });
    expect(await resolveOnDemandDraft(orgId)).toBeNull();
  });

  it("tenant isolation — never resolves a draft belonging to a different organization", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    await seedOnDemandService(orgA);
    expect(await resolveOnDemandDraft(orgB)).toBeNull();
  });
});

describe("hasSentAnyOnDemandRequest", () => {
  it("is false for a brand-new organization", async () => {
    const orgId = await seedOrg();
    expect(await hasSentAnyOnDemandRequest(orgId)).toBe(false);
  });

  it("is false while a draft exists but hasn't been sent yet", async () => {
    const orgId = await seedOrg();
    await seedOnDemandService(orgId);
    expect(await hasSentAnyOnDemandRequest(orgId)).toBe(false);
  });

  it("becomes true the moment any on-demand request is genuinely sent", async () => {
    const orgId = await seedOrg();
    const serviceId = await seedOnDemandService(orgId);
    await markSent(orgId, serviceId);
    expect(await hasSentAnyOnDemandRequest(orgId)).toBe(true);
  });

  it("tenant isolation — one organization sending never flips this true for another", async () => {
    const orgA = await seedOrg();
    const orgB = await seedOrg();
    const serviceId = await seedOnDemandService(orgA);
    await markSent(orgA, serviceId);

    expect(await hasSentAnyOnDemandRequest(orgB)).toBe(false);
    expect(await hasSentAnyOnDemandRequest(orgA)).toBe(true);
  });
});
