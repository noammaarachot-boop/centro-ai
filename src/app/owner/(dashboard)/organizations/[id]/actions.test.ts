import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { OwnerSession } from "@/lib/auth/ownerSession";
import { decryptWhatsAppToken } from "@/lib/whatsapp/tokenCipher";

// Manual per-organization WhatsApp connection — proves the owner-only
// "check & connect" action end to end: verifies the token/WABA/phone
// number against Meta BEFORE ever writing anything, never saves a failed
// attempt, never leaks the token into an error/redirect/audit entry, and
// is reachable only through the owner session gate (never a regular
// organization session).

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentOwnerSession: OwnerSession;
vi.mock("@/lib/auth/ownerSession", () => ({
  requireOwnerSession: vi.fn(async () => currentOwnerSession),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

// subscribeToWabaWebhooks (called for real below, not mocked) reads
// getWhatsAppConfig() for appId/appSecret/the shared system-token fallback
// — same fake values embeddedSignup.test.ts already uses for the identical
// reason.
vi.mock("@/lib/whatsapp/config", () => ({
  getWhatsAppConfig: () => ({
    appId: "app-1",
    appSecret: "secret-1",
    oauthRedirectUri: null,
    systemUserToken: "fake-system-token",
    webhookVerifyToken: "fake-verify-token",
  }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const fetchMock = vi.fn();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  const [platformOwner] = await db
    .insert(schema.platformOwners)
    .values({ email: `${crypto.randomUUID()}@centro-ai.co.il`, passwordHash: "x" })
    .returning();
  currentOwnerSession = { sessionId: "owner-s1", platformOwnerId: platformOwner.id, email: platformOwner.email };
});

const { manuallyConnectWhatsAppAction } = await import("./actions");

async function seedOrg(name = "Org") {
  const [org] = await db.insert(schema.organizations).values({ name }).returning();
  return org.id;
}

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

async function expectRedirect(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error("expected a redirect");
  } catch (err) {
    const message = (err as Error).message;
    if (!message.startsWith("NEXT_REDIRECT:")) throw err;
    const url = message.slice("NEXT_REDIRECT:".length);
    return { pathname: url.split("?")[0], params: Object.fromEntries(new URL(url, "http://x").searchParams) };
  }
}

function mockMetaVerifySuccess(phoneNumberId: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{ id: phoneNumberId, display_phone_number: "+972500009999", verified_name: "לקוח בדיקה" }],
    }),
  });
}

// Routes each Meta call by URL so a single step (e.g. the per-number
// webhook override) can be failed independently of the others.
function mockMetaByUrl(options: { overrideOk: boolean; phoneNumberId: string }) {
  fetchMock.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.includes("/phone_numbers")) {
      return {
        ok: true,
        json: async () => ({
          data: [
            { id: options.phoneNumberId, display_phone_number: "+972500009999", verified_name: "לקוח בדיקה" },
          ],
        }),
      };
    }
    // The per-number override POSTs to the phone number's own node — no
    // "/phone_numbers" and no "/subscribed_apps" in the path.
    if (target.endsWith(`/${options.phoneNumberId}`)) {
      return options.overrideOk
        ? { ok: true, json: async () => ({ success: true }) }
        : { ok: false, status: 400, text: async () => "override rejected" };
    }
    return { ok: true, json: async () => ({ success: true }), text: async () => "" };
  });
}

describe("manuallyConnectWhatsAppAction — verifies against Meta before ever saving", () => {
  it("on success: stores the connection, encrypts the token, and redirects with whatsappConnected=1", async () => {
    const orgId = await seedOrg();
    mockMetaVerifySuccess("phone-1");

    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "EAAG_real_token" })
      )
    );
    expect(result.pathname).toBe(`/owner/organizations/${orgId}`);
    expect(result.params.whatsappConnected).toBe("1");

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappBusinessAccountId).toBe("waba-1");
    expect(org.whatsappPhoneNumberId).toBe("phone-1");
    expect(org.whatsappDisplayPhoneNumber).toBe("+972500009999");
    expect(org.whatsappVerifiedName).toBe("לקוח בדיקה");
    expect(org.whatsappConnectedAt).not.toBeNull();
    expect(org.documentCollectionEnabled).toBe(true);
    // Encrypted, never plaintext.
    expect(org.whatsappAccessTokenEnc).not.toBeNull();
    expect(org.whatsappAccessTokenEnc).not.toContain("EAAG_real_token");
    expect(decryptWhatsAppToken(org.whatsappAccessTokenEnc!)).toBe("EAAG_real_token");
  });

  it("on success: also subscribes the WABA to Centro's webhook using the entered token — no separate manual Meta call needed", async () => {
    const orgId = await seedOrg();
    mockMetaVerifySuccess("phone-1");

    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "EAAG_real_token" })
      )
    );

    const subscribeCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/waba-1/subscribed_apps"));
    expect(subscribeCall).toBeDefined();
    const [, init] = subscribeCall!;
    expect(init.headers.Authorization).toBe("Bearer EAAG_real_token");

    const audits = await db.select().from(schema.platformOwnerAuditLog);
    const relevant = audits.find((a) => a.eventType === "owner.whatsapp_manually_connected");
    expect((relevant?.metadata as Record<string, unknown> | null)?.webhooksSubscribed).toBe(true);
  });

  it("webhook subscription fails (e.g. token lacks whatsapp_business_management) — nothing is saved, and the owner sees a clear error", async () => {
    const orgId = await seedOrg();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "phone-1", display_phone_number: "+972500009999", verified_name: "לקוח בדיקה" }],
        }),
      })
      .mockResolvedValue({ ok: false, status: 403, text: async () => "missing permission" });

    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "token-without-management" })
      )
    );
    expect(result.params.whatsappError).toBeTruthy();
    expect(decodeURIComponent(result.params.whatsappError)).toMatch(/Webhook/);

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBeNull();
    expect(org.whatsappAccessTokenEnc).toBeNull();
  });

  it("registers a per-number webhook override and stores its verify token, so the owner screen can show a dedicated URL", async () => {
    const orgId = await seedOrg();
    // Distinct ids per test — organizations_whatsapp_phone_number_id_idx /
    // _business_account_id_idx are global unique indexes, so reusing an id
    // an earlier test already connected would fail as a conflict.
    mockMetaByUrl({ overrideOk: true, phoneNumberId: "phone-override-ok" });

    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({
          organizationId: orgId,
          wabaId: "waba-override-ok",
          phoneNumberId: "phone-override-ok",
          accessToken: "EAAG_token",
        })
      )
    );

    const overrideCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/phone-override-ok"));
    expect(overrideCall).toBeDefined();
    const body = JSON.parse(overrideCall![1].body);
    expect(body.webhook_configuration.override_callback_uri).toBe(
      "https://www.centro-ai.co.il/api/webhooks/whatsapp/phone-override-ok"
    );

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappWebhookVerifyToken).toBeTruthy();
    // The token Meta was handed is exactly the one persisted — otherwise
    // the handshake against our own route could never succeed.
    expect(body.webhook_configuration.verify_token).toBe(org.whatsappWebhookVerifyToken);
  });

  it("ORDERING: the verify token is already in the database BEFORE Meta is asked to register the override (Meta handshakes the URL during that call)", async () => {
    const orgId = await seedOrg();
    let tokenVisibleToHandshake: string | null = null;

    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes("/phone_numbers")) {
        return {
          ok: true,
          json: async () => ({
            data: [{ id: "phone-order", display_phone_number: "+972500009999", verified_name: "לקוח בדיקה" }],
          }),
        };
      }
      if (target.endsWith("/phone-order")) {
        // Stand-in for Meta's GET hub.challenge against our own route,
        // which resolves the token by phoneNumberId — if the row isn't
        // written yet, the real handshake would fail.
        const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
        tokenVisibleToHandshake = row.whatsappWebhookVerifyToken;
        return { ok: true, json: async () => ({ success: true }) };
      }
      return { ok: true, json: async () => ({ success: true }), text: async () => "" };
    });

    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({
          organizationId: orgId,
          wabaId: "waba-order",
          phoneNumberId: "phone-order",
          accessToken: "EAAG_token",
        })
      )
    );

    expect(tokenVisibleToHandshake).toBeTruthy();
  });

  it("a failed override does NOT fail the connection — it stays saved (Meta falls back to the shared URL), and the token is cleared so no dead URL is advertised", async () => {
    const orgId = await seedOrg();
    mockMetaByUrl({ overrideOk: false, phoneNumberId: "phone-override-fail" });

    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({
          organizationId: orgId,
          wabaId: "waba-override-fail",
          phoneNumberId: "phone-override-fail",
          accessToken: "EAAG_token",
        })
      )
    );
    expect(result.params.whatsappConnected).toBe("1"); // still a successful connection
    expect(result.params.webhookOverrideFailed).toBe("1"); // but the owner is told

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBe("phone-override-fail"); // connection intact
    expect(org.whatsappAccessTokenEnc).not.toBeNull();
    expect(org.whatsappWebhookVerifyToken).toBeNull(); // cleared — nothing to advertise
  });

  it("records an audit event that never contains the token itself", async () => {
    const orgId = await seedOrg();
    mockMetaVerifySuccess("phone-1");
    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "super-secret-token-value" })
      )
    );

    const audits = await db.select().from(schema.platformOwnerAuditLog);
    const relevant = audits.find((a) => a.eventType === "owner.whatsapp_manually_connected");
    expect(relevant).toBeDefined();
    expect(JSON.stringify(relevant)).not.toContain("super-secret-token-value");
  });

  it("rejects with a clear error when a required field is missing, and writes nothing", async () => {
    const orgId = await seedOrg();
    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "", accessToken: "x" }))
    );
    expect(result.params.whatsappError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBeNull();
  });

  it("rejects when the token is invalid/unauthorized (401), and never saves anything", async () => {
    const orgId = await seedOrg();
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "" });

    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "bad-token" })
      )
    );
    expect(result.params.whatsappError).toBeTruthy();
    expect(decodeURIComponent(result.params.whatsappError)).toMatch(/אינו תקף|הרשאה/);
    expect(decodeURIComponent(result.params.whatsappError)).not.toContain("bad-token");

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBeNull();
    expect(org.whatsappAccessTokenEnc).toBeNull();
  });

  it("rejects when the phone number doesn't belong to the given WABA, and never saves anything", async () => {
    const orgId = await seedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "some-other-phone", display_phone_number: "+972500000000", verified_name: "Other" }] }),
    });

    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "waba-1", phoneNumberId: "phone-1", accessToken: "token" })
      )
    );
    expect(result.params.whatsappError).toBeTruthy();

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBeNull();
  });

  it("refuses a phone/WABA already connected to a different organization (existing DB-level uniqueness, unchanged)", async () => {
    const orgA = await seedOrg("Org A");
    const orgB = await seedOrg("Org B");
    mockMetaVerifySuccess("phone-shared");
    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgA, wabaId: "waba-shared", phoneNumberId: "phone-shared", accessToken: "token-a" })
      )
    );

    mockMetaVerifySuccess("phone-shared");
    const result = await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgB, wabaId: "waba-shared", phoneNumberId: "phone-shared", accessToken: "token-b" })
      )
    );
    expect(result.params.whatsappError).toBeTruthy();

    const [orgBRow] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgB));
    expect(orgBRow.whatsappPhoneNumberId).toBeNull();
  });

  it("never touches an organization's EXISTING (e.g. Embedded Signup) WhatsApp connection when verification fails", async () => {
    const orgId = await seedOrg();
    // Simulate an org already connected the Embedded Signup way.
    await db
      .update(schema.organizations)
      .set({
        whatsappBusinessAccountId: "old-waba",
        whatsappPhoneNumberId: "old-phone",
        whatsappDisplayPhoneNumber: "+972500001111",
        whatsappConnectedAt: new Date(),
      })
      .where(eq(schema.organizations.id, orgId));

    fetchMock.mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    await expectRedirect(() =>
      manuallyConnectWhatsAppAction(
        formData({ organizationId: orgId, wabaId: "new-waba", phoneNumberId: "new-phone", accessToken: "bad-token" })
      )
    );

    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(org.whatsappPhoneNumberId).toBe("old-phone"); // untouched
    expect(org.whatsappBusinessAccountId).toBe("old-waba");
  });
});
