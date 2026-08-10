import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

let db: Database;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

const { storeWabaConnection, WhatsAppConnectionConflictError } = await import("./wabaTokens");

async function seedOrg(name: string) {
  const [org] = await db.insert(schema.organizations).values({ name }).returning();
  return org.id;
}

describe("storeWabaConnection", () => {
  it("stores the connection identifiers and enables automated document collection", async () => {
    const orgId = await seedOrg("Org A");
    await storeWabaConnection(
      orgId,
      { businessAccountId: "waba-1", phoneNumberId: "phone-1", displayPhoneNumber: "+972500000001", verifiedName: "Org A" },
      db
    );
    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.whatsappPhoneNumberId).toBe("phone-1");
    expect(after.whatsappBusinessAccountId).toBe("waba-1");
    expect(after.documentCollectionEnabled).toBe(true);
  });

  it("refuses (WhatsAppConnectionConflictError) to connect a phoneNumberId already used by a different organization — the DB-level tenant-routing backstop", async () => {
    const orgB = await seedOrg("Org B");
    const orgC = await seedOrg("Org C");
    await storeWabaConnection(
      orgB,
      { businessAccountId: "waba-b", phoneNumberId: "shared-phone", displayPhoneNumber: "+972500000002", verifiedName: "Org B" },
      db
    );

    await expect(
      storeWabaConnection(
        orgC,
        { businessAccountId: "waba-c", phoneNumberId: "shared-phone", displayPhoneNumber: "+972500000002", verifiedName: "Org C" },
        db
      )
    ).rejects.toBeInstanceOf(WhatsAppConnectionConflictError);

    // Org C's row must stay untouched by the failed attempt — never a
    // half-written connection.
    const [afterC] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgC));
    expect(afterC.whatsappPhoneNumberId).toBeNull();
  });

  it("refuses to connect a businessAccountId already used by a different organization", async () => {
    const orgD = await seedOrg("Org D");
    const orgE = await seedOrg("Org E");
    await storeWabaConnection(
      orgD,
      { businessAccountId: "shared-waba", phoneNumberId: "phone-d", displayPhoneNumber: "+972500000003", verifiedName: "Org D" },
      db
    );

    await expect(
      storeWabaConnection(
        orgE,
        { businessAccountId: "shared-waba", phoneNumberId: "phone-e", displayPhoneNumber: "+972500000004", verifiedName: "Org E" },
        db
      )
    ).rejects.toBeInstanceOf(WhatsAppConnectionConflictError);
  });

  it("a disconnected organization (phoneNumberId cleared to null) frees it for reconnection elsewhere", async () => {
    const orgF = await seedOrg("Org F");
    const orgG = await seedOrg("Org G");
    await storeWabaConnection(
      orgF,
      { businessAccountId: "waba-f", phoneNumberId: "reusable-phone", displayPhoneNumber: "+972500000005", verifiedName: "Org F" },
      db
    );
    // Mirrors clearWabaConnection's own update (see wabaTokens.ts) — done
    // directly here since clearWabaConnection has no dbOverride injection
    // point of its own (only storeWabaConnection does), so it can't target
    // this test's isolated PGlite instance.
    await db
      .update(schema.organizations)
      .set({ whatsappPhoneNumberId: null, whatsappBusinessAccountId: null })
      .where(eq(schema.organizations.id, orgF));

    await expect(
      storeWabaConnection(
        orgG,
        { businessAccountId: "waba-g", phoneNumberId: "reusable-phone", displayPhoneNumber: "+972500000005", verifiedName: "Org G" },
        db
      )
    ).resolves.toBeUndefined();
  });
});
