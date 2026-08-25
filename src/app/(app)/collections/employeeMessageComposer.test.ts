import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

/**
 * Regression — the composer must RESOLVE, never redirect.
 *
 * sendEmployeeMessageWithFeedback is a useActionState action, and a
 * redirect thrown out of one never reaches React as a settled result. It
 * used to delegate to an action ending in redirect(), and end-to-end QA
 * measured the consequence: the message row was written 28ms in, and 45
 * seconds later the send button still read "שולח…" with no error, no
 * message echoed and no navigation. An employee could not tell whether the
 * client had received it, and clicking again — the obvious thing to do —
 * sends it twice.
 *
 * So the property under test is the shape of the result, not the wording:
 * this action RETURNS on success and on failure, and never throws a
 * redirect. That is the thing that broke, and the thing a future refactor
 * could quietly break again.
 */

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

// redirect() is the failure mode under test: if the action ever calls it,
// this throws exactly like Next does, and the assertions below catch it.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    const error = new Error(`NEXT_REDIRECT:${url}`) as Error & { digest: string };
    error.digest = `NEXT_REDIRECT;push;${url};307;`;
    throw error;
  }),
}));

const refresh = vi.fn();
vi.mock("next/cache", () => ({
  refresh: (...args: unknown[]) => refresh(...args),
}));

const sendOutboundMessage = vi.fn();
vi.mock("@/lib/conversationOrchestration", async () => {
  const actual = await vi.importActual<typeof import("@/lib/conversationOrchestration")>(
    "@/lib/conversationOrchestration"
  );
  return {
    ...actual,
    sendOutboundMessage: (...args: unknown[]) => sendOutboundMessage(...args),
  };
});

const { sendEmployeeMessageWithFeedback } = await import("./conversationActions");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

let requestId: string;

beforeEach(async () => {
  refresh.mockReset();
  sendOutboundMessage.mockReset();
  sendOutboundMessage.mockResolvedValue(undefined);

  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `owner-${Date.now()}-${Math.random()}@example.com`, passwordHash: "x" })
    .returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000111" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "שירות" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "2026-Q1", status: "active" })
    .returning();
  requestId = request.id;
  currentSession = {
    userId: user.id,
    organizationId: org.id,
    organizationName: "Org",
    email: user.email,
  } as unknown as Session;
});

function form(body: string) {
  const data = new FormData();
  data.append("body", body);
  return data;
}

describe("sendEmployeeMessageWithFeedback", () => {
  it("returns a state on success instead of throwing a redirect", async () => {
    const result = await sendEmployeeMessageWithFeedback(requestId, {}, form("שלום"));
    expect(result).toEqual({});
    expect(sendOutboundMessage).toHaveBeenCalledTimes(1);
  });

  it("refreshes the page it posted back to, so the sent message appears", async () => {
    await sendEmployeeMessageWithFeedback(requestId, {}, form("שלום"));
    expect(refresh, "the thread must be revalidated after a send").toHaveBeenCalledTimes(1);
  });

  it("reports a failed send as an error state, still without throwing", async () => {
    sendOutboundMessage.mockRejectedValueOnce(new Error("whatsapp is not connected"));
    const result = await sendEmployeeMessageWithFeedback(requestId, {}, form("שלום"));
    expect(result.error, "the employee has to be told it did not go out").toBeTruthy();
    expect(refresh, "a failed send must not claim success by refreshing").not.toHaveBeenCalled();
  });

  it("rejects an empty message without sending anything", async () => {
    const result = await sendEmployeeMessageWithFeedback(requestId, {}, form("   "));
    expect(result.error).toBeTruthy();
    expect(sendOutboundMessage).not.toHaveBeenCalled();
  });

  it("sends exactly one message per submission", async () => {
    await sendEmployeeMessageWithFeedback(requestId, {}, form("פעם אחת"));
    expect(sendOutboundMessage).toHaveBeenCalledTimes(1);
    const [, , body] = sendOutboundMessage.mock.calls[0];
    expect(body).toBe("פעם אחת");
  });

  it("still redirects — a real navigation — when the request is not this organization's", async () => {
    const [otherOrg] = await db.insert(schema.organizations).values({ name: "אחר" }).returning();
    const [otherClient] = await db
      .insert(schema.clients)
      .values({ organizationId: otherOrg.id, name: "זר", phone: "+972500000222" })
      .returning();
    const [otherService] = await db.insert(schema.services).values({ organizationId: otherOrg.id, name: "s" }).returning();
    const [foreign] = await db
      .insert(schema.collectionRequests)
      .values({
        organizationId: otherOrg.id,
        clientId: otherClient.id,
        serviceId: otherService.id,
        periodLabel: "p",
        status: "active",
      })
      .returning();

    // A tenant boundary is a genuine navigation, not a "send failed"
    // message — so this one SHOULD throw a redirect, and must not be
    // swallowed into an error state.
    await expect(sendEmployeeMessageWithFeedback(foreign.id, {}, form("שלום"))).rejects.toThrow(/NEXT_REDIRECT/);
    expect(sendOutboundMessage).not.toHaveBeenCalled();
    const rows = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, foreign.id));
    expect(rows).toHaveLength(1);
  });
});
