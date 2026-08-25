import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

/**
 * Regression — one client per real phone number.
 *
 * Found by end-to-end QA: the create form checked uniqueness against the
 * raw string, so "0509998877", "+972509998877", "+972-50-999-8877",
 * "972509998877" and "050-999-8877" were five different clients. Inbound
 * WhatsApp routing does NOT work that way — matchClientByPhone resolves a
 * message with `toE164(client.phone) === target` — so a message from that
 * one number landed on whichever of the five the scan reached first, and
 * which one that was is not something the product decides.
 *
 * These tests go through the real createClient/updateClient actions, not
 * through isSamePhoneNumber directly, because the defect was in which
 * comparison the action performed, not in the comparison itself.
 */

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

// createClient/updateClient end in redirect(); Vitest calls the action
// directly rather than through Next's request pipeline, so the throw it
// normally uses to signal navigation has to be caught here. A pure harness
// shim — the actions are unchanged.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

// The business-type classifier makes a real AI call on create. Not what
// these tests are about, and it must not make the suite depend on a
// network round-trip.
vi.mock("@/lib/ai/businessTypeClassifier", () => ({
  AUTO_CLASSIFY_CONFIDENCE: 90,
  SUGGESTED_CONFIDENCE: 60,
  classifyClientBusinessType: vi.fn(async () => ({
    businessTypeId: null,
    confidence: 0,
    method: "none",
    reason: "stubbed in test",
  })),
}));

const { createClient, updateClient } = await import("./actions");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let seq = 0;
async function freshOrg() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  // A real users row: recordAuditEvent writes actor_user_id, which carries a
  // foreign key, so a made-up id would fail on the audit write rather than
  // on anything these tests are about.
  const [user] = await db
    .insert(schema.users)
    .values({
      organizationId: org.id,
      email: `owner-${(seq += 1)}-${Date.now()}@example.com`,
      passwordHash: "not-a-real-hash",
    })
    .returning();
  currentSession = {
    userId: user.id,
    organizationId: org.id,
    organizationName: "Org",
    email: user.email,
  } as unknown as Session;
  return org;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  return data;
}

/** Runs an action that ends in redirect(), returning either its state or the path. */
async function run(action: Promise<unknown>): Promise<{ state?: unknown; redirectedTo?: string }> {
  try {
    return { state: await action };
  } catch (error) {
    const message = String((error as Error).message ?? "");
    if (message.startsWith("NEXT_REDIRECT:")) return { redirectedTo: message.slice("NEXT_REDIRECT:".length) };
    throw error;
  }
}

const PHONE_VARIANTS = [
  "+972509998877",
  "+972-50-999-8877",
  "972509998877",
  "050-999-8877",
  "050 999 8877",
  "00972509998877",
];

describe("createClient — one client per real phone number", () => {
  it("rejects every formatting of a number that already belongs to a client", async () => {
    const org = await freshOrg();
    const first = await run(createClient({}, form({ name: "לקוח א", phone: "0509998877" })));
    expect(first.redirectedTo, "the first client should be created").toBeDefined();

    for (const variant of PHONE_VARIANTS) {
      const attempt = await run(createClient({}, form({ name: `וריאנט ${variant}`, phone: variant })));
      expect(attempt.redirectedTo, `"${variant}" must not create a second client`).toBeUndefined();
      expect(attempt.state, `"${variant}" must report the conflict on the phone field`).toEqual({
        fieldErrors: { phone: "מספר טלפון זה כבר משויך ללקוח אחר." },
      });
    }

    const rows = await db.select().from(schema.clients).where(eq(schema.clients.organizationId, org.id));
    expect(rows, "exactly one client for one real number").toHaveLength(1);
  });

  it("still allows a genuinely different number", async () => {
    await freshOrg();
    const a = await run(createClient({}, form({ name: "א", phone: "0509998877" })));
    const b = await run(createClient({}, form({ name: "ב", phone: "0509998878" })));
    expect(a.redirectedTo).toBeDefined();
    expect(b.redirectedTo).toBeDefined();
  });

  it("scopes the check to one organization — the same number may exist in another tenant", async () => {
    await freshOrg();
    const mine = await run(createClient({}, form({ name: "שלי", phone: "0509998877" })));
    expect(mine.redirectedTo).toBeDefined();

    await freshOrg(); // a different organization, same session shape
    const theirs = await run(createClient({}, form({ name: "של אחר", phone: "+972509998877" })));
    expect(theirs.redirectedTo, "another tenant's identical number must not collide").toBeDefined();
  });
});

describe("updateClient — the same rule, without blocking the row being edited", () => {
  it("lets a client keep its own number, in any formatting", async () => {
    const org = await freshOrg();
    await run(createClient({}, form({ name: "לקוח", phone: "0509998877" })));
    const [row] = await db.select().from(schema.clients).where(eq(schema.clients.organizationId, org.id));

    const renamed = await run(
      updateClient(row.id, {}, form({ name: "לקוח מעודכן", phone: "+972-50-999-8877" }))
    );
    expect(renamed.redirectedTo, "editing a client must not collide with itself").toBeDefined();
  });

  it("rejects taking over a number that belongs to a different client", async () => {
    const org = await freshOrg();
    await run(createClient({}, form({ name: "א", phone: "0509998877" })));
    await run(createClient({}, form({ name: "ב", phone: "0501112222" })));
    const rows = await db.select().from(schema.clients).where(eq(schema.clients.organizationId, org.id));
    const second = rows.find((r) => r.name === "ב")!;

    const attempt = await run(updateClient(second.id, {}, form({ name: "ב", phone: "+972509998877" })));
    expect(attempt.redirectedTo).toBeUndefined();
    expect(attempt.state).toEqual({ fieldErrors: { phone: "מספר טלפון זה כבר משויך ללקוח אחר." } });
  });
});
