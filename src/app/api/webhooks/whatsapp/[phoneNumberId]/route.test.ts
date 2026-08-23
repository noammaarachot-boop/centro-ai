import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { NextRequest } from "next/server";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Per-phone-number webhook override endpoint. The one thing that genuinely
// differs from the shared app-level route is the GET handshake: it must
// answer with THIS number's own verify token, so one tenant's token can
// never verify another tenant's endpoint, and the shared app-level token
// is never accepted here at all.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { GET } = await import("./route");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedConnectedOrg(phoneNumberId: string, verifyToken: string | null) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: phoneNumberId,
      whatsappWebhookVerifyToken: verifyToken,
    })
    .returning();
  return org.id;
}

function handshakeRequest(token: string, challenge = "challenge-123") {
  const url = new URL("https://www.centro-ai.co.il/api/webhooks/whatsapp/x");
  url.searchParams.set("hub.mode", "subscribe");
  url.searchParams.set("hub.verify_token", token);
  url.searchParams.set("hub.challenge", challenge);
  return new NextRequest(url);
}

function params(phoneNumberId: string) {
  return { params: Promise.resolve({ phoneNumberId }) };
}

describe("GET — per-number handshake", () => {
  it("echoes hub.challenge back verbatim when the token matches this phone number's own stored token", async () => {
    await seedConnectedOrg("phone-a", "token-a");

    const response = await GET(handshakeRequest("token-a"), params("phone-a"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-123");
  });

  it("rejects another organization's verify token — tenant isolation at the handshake itself", async () => {
    await seedConnectedOrg("phone-b", "token-b");
    await seedConnectedOrg("phone-c", "token-c");

    const response = await GET(handshakeRequest("token-c"), params("phone-b"));

    expect(response.status).toBe(403);
  });

  it("rejects the shared app-level verify token — this endpoint only ever accepts its own", async () => {
    process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = "shared-app-level-token";
    await seedConnectedOrg("phone-d", "token-d");

    const response = await GET(handshakeRequest("shared-app-level-token"), params("phone-d"));

    expect(response.status).toBe(403);
  });

  it("rejects a phone number that has no override registered (null token) — never falls back to accepting anything", async () => {
    await seedConnectedOrg("phone-e", null);

    expect((await GET(handshakeRequest("token-e"), params("phone-e"))).status).toBe(403);
    expect((await GET(handshakeRequest(""), params("phone-e"))).status).toBe(403);
  });

  it("rejects an unknown phone number id outright", async () => {
    const response = await GET(handshakeRequest("any-token"), params("phone-does-not-exist"));
    expect(response.status).toBe(403);
  });

  it("rejects a malformed handshake (wrong hub.mode, or no challenge) even with a valid token", async () => {
    await seedConnectedOrg("phone-f", "token-f");

    const wrongMode = new URL("https://www.centro-ai.co.il/api/webhooks/whatsapp/phone-f");
    wrongMode.searchParams.set("hub.mode", "unsubscribe");
    wrongMode.searchParams.set("hub.verify_token", "token-f");
    wrongMode.searchParams.set("hub.challenge", "c");
    expect((await GET(new NextRequest(wrongMode), params("phone-f"))).status).toBe(403);

    const noChallenge = new URL("https://www.centro-ai.co.il/api/webhooks/whatsapp/phone-f");
    noChallenge.searchParams.set("hub.mode", "subscribe");
    noChallenge.searchParams.set("hub.verify_token", "token-f");
    expect((await GET(new NextRequest(noChallenge), params("phone-f"))).status).toBe(403);
  });
});
