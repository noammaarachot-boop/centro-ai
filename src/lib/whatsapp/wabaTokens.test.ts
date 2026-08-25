import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

let db: Database;

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

const { storeWabaConnection, WhatsAppConnectionConflictError } = await import("./wabaTokens");
const { decryptWhatsAppToken } = await import("./tokenCipher");

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

// Manual per-organization WhatsApp connection — the Access Token, when
// provided, is stored encrypted (never plaintext), and an Embedded-Signup
// connection (no accessToken passed) never gets a value in that column at
// all — both proven directly against the real row, not just the function's
// return value.
describe("storeWabaConnection — manual connection's Access Token", () => {
  it("encrypts the access token before writing it — never stored in plaintext", async () => {
    const orgId = await seedOrg("Org H");
    await storeWabaConnection(
      orgId,
      {
        businessAccountId: "waba-h",
        phoneNumberId: "phone-h",
        displayPhoneNumber: "+972500000006",
        verifiedName: "Org H",
        accessToken: "EAAG_real_looking_token",
      },
      db
    );

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.whatsappAccessTokenEnc).not.toBeNull();
    expect(after.whatsappAccessTokenEnc).not.toBe("EAAG_real_looking_token");
    expect(after.whatsappAccessTokenEnc).not.toContain("EAAG_real_looking_token");
    expect(decryptWhatsAppToken(after.whatsappAccessTokenEnc!)).toBe("EAAG_real_looking_token");
  });

  it("leaves whatsappAccessTokenEnc null for a connection with no accessToken (the existing Embedded Signup flow)", async () => {
    const orgId = await seedOrg("Org I");
    await storeWabaConnection(
      orgId,
      { businessAccountId: "waba-i", phoneNumberId: "phone-i", displayPhoneNumber: "+972500000007", verifiedName: "Org I" },
      db
    );

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.whatsappAccessTokenEnc).toBeNull();
  });
});
