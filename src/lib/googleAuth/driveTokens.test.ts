import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

/**
 * Root-cause fix (production incident, 2026-08) — a Google Drive token
 * stored under a since-rotated GOOGLE_TOKEN_ENCRYPTION_KEY can no longer be
 * decrypted, which surfaced as: checkIntegrationStatus correctly reporting
 * driveReady=false (working as designed), AND the "Disconnect" button
 * ALSO failing (clearTokens tried to decrypt the same broken token to
 * revoke it with Google, threw, and never reached the DB clear). These
 * tests prove the fix's exact contract: an explicit Disconnect always
 * clears local credentials even when revoke/decrypt fails, while a
 * routine check failure (getValidAccessToken) never deletes anything on
 * its own — only clearTokens, only when actually called.
 */

const revokeToken = vi.fn();
vi.mock("./oauthClient", async () => {
  const actual = await vi.importActual<typeof import("./oauthClient")>("./oauthClient");
  return { ...actual, revokeToken: (...args: unknown[]) => revokeToken(...args) };
});

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrgWithGoogleTokens(overrides: Partial<typeof schema.organizations.$inferInsert> = {}) {
  const { encryptToken } = await import("./tokenCipher");
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      googleConnectedAt: new Date(),
      googleAccessTokenEnc: encryptToken("real-access-token"),
      googleRefreshTokenEnc: encryptToken("real-refresh-token"),
      googleTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      googleDriveFolderId: "folder-1",
      googleDriveFolderName: "תיקייה",
      ...overrides,
    })
    .returning();
  return org;
}

beforeEach(() => {
  revokeToken.mockReset();
  revokeToken.mockResolvedValue(undefined);
});

describe("clearTokens (explicit Disconnect) — revoke succeeds", () => {
  it("revokes with Google and clears every local credential field", async () => {
    const org = await seedOrgWithGoogleTokens();
    const { clearTokens } = await import("./driveTokens");

    await clearTokens(org.id);

    expect(revokeToken).toHaveBeenCalledTimes(1);
    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
    expect(after.googleConnectedAt).toBeNull();
    expect(after.googleAccessTokenEnc).toBeNull();
    expect(after.googleRefreshTokenEnc).toBeNull();
    expect(after.googleTokenExpiresAt).toBeNull();
    expect(after.googleDriveFolderId).toBeNull();
    expect(after.googleDriveFolderName).toBeNull();
  });
});

describe("clearTokens (explicit Disconnect) — revoke/decrypt fails (the production incident)", () => {
  it("still clears every local credential field and completes without throwing, when the stored token is undecryptable", async () => {
    // Same production scenario: the token was encrypted under a DIFFERENT
    // key than the one currently configured, so decryptToken throws before
    // revokeToken is ever reached — proven by asserting revokeToken was
    // never called, not just that clearTokens didn't throw.
    const { encryptToken } = await import("./tokenCipher");
    const savedKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64"); // a different key
    const encryptedUnderOldKey = encryptToken("stale-refresh-token");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = savedKey; // restore the "current" key — now undecryptable

    const org = await seedOrgWithGoogleTokens({ googleRefreshTokenEnc: encryptedUnderOldKey });
    const { clearTokens } = await import("./driveTokens");

    await expect(clearTokens(org.id)).resolves.toBeUndefined();

    expect(revokeToken).not.toHaveBeenCalled();
    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
    expect(after.googleConnectedAt).toBeNull();
    expect(after.googleAccessTokenEnc).toBeNull();
    expect(after.googleRefreshTokenEnc).toBeNull();
    expect(after.googleDriveFolderId).toBeNull();
  });

  it("also clears credentials when revokeToken itself rejects (network/API failure, not just decrypt)", async () => {
    revokeToken.mockRejectedValueOnce(new Error("network timeout"));
    const org = await seedOrgWithGoogleTokens();
    const { clearTokens } = await import("./driveTokens");

    await expect(clearTokens(org.id)).resolves.toBeUndefined();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
    expect(after.googleAccessTokenEnc).toBeNull();
  });
});

describe("getValidAccessToken (routine check, NOT a Disconnect) — never deletes credentials on failure", () => {
  it("a token that fails to decrypt is reported as a failure to the caller, and local credentials are left completely untouched", async () => {
    const { encryptToken } = await import("./tokenCipher");
    const savedKey = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY;
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
    const encryptedUnderOldKey = encryptToken("stale-access-token");
    process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = savedKey;

    const org = await seedOrgWithGoogleTokens({ googleAccessTokenEnc: encryptedUnderOldKey });
    const { getValidAccessToken } = await import("./driveTokens");

    await expect(getValidAccessToken(org.id)).rejects.toThrow();

    // The exact regression this test guards against: a routine readiness
    // check (this is what checkIntegrationStatus calls) must never itself
    // wipe out the organization's Google connection — only an explicit
    // Disconnect (clearTokens) may do that.
    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, org.id));
    expect(after.googleConnectedAt).not.toBeNull();
    expect(after.googleAccessTokenEnc).not.toBeNull();
    expect(after.googleDriveFolderId).not.toBeNull();
    expect(revokeToken).not.toHaveBeenCalled();
  });
});
