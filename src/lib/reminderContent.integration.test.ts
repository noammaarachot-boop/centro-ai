import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Dynamic reminder content (mandatory scenarios #15/#16): within the 24h
// WhatsApp session window a reminder can use natural free text naming
// exactly what's missing; outside it, only the pre-approved Template may
// be sent — never silently fails, always falls back to the already-
// approved static template until centro_reminder_v2 is live.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { buildReminderSend } = await import("./reminderContent");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedRequestWithMissingRequirement(inboundMessageAgeHours: number | null) {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [clientRow] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "רז שלום", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: clientRow.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({ organizationId: org.id, clientId: clientRow.id, collectionRequestId: request.id })
    .returning();
  await db.insert(schema.collectionRequestRequirements).values({
    collectionRequestId: request.id,
    name: "אישור שכירות",
    requiredCount: 1,
  });
  if (inboundMessageAgeHours !== null) {
    await db.insert(schema.messages).values({
      organizationId: org.id,
      conversationId: conversation.id,
      direction: "inbound",
      senderType: "client",
      body: "היי",
      createdAt: new Date(Date.now() - inboundMessageAgeHours * 60 * 60 * 1000),
    });
  }
  return { conversationId: conversation.id, requestId: request.id };
}

describe("mandatory #15: reminder within the 24h session window uses free text", () => {
  it("names exactly the missing document, as natural free text with allowFreeform true", async () => {
    const { conversationId, requestId } = await seedRequestWithMissingRequirement(2); // 2h ago — within window

    const send = await buildReminderSend(conversationId, requestId, "רז שלום");
    expect(send.allowFreeform).toBe(true);
    expect(send.templateSend).toBeUndefined();
    expect(send.body).toContain("אישור שכירות");
    expect(send.body).toContain("רז שלום");
  });
});

describe("mandatory #16: reminder outside the 24h window uses the Meta template", () => {
  it("never sent as free text once the window has closed", async () => {
    const { conversationId, requestId } = await seedRequestWithMissingRequirement(30); // 30h ago — window closed

    const send = await buildReminderSend(conversationId, requestId, "רז שלום");
    expect(send.allowFreeform).toBe(false);
  });

  it("no inbound message at all (never messaged) also falls outside the window", async () => {
    const { conversationId, requestId } = await seedRequestWithMissingRequirement(null);

    const send = await buildReminderSend(conversationId, requestId, "רז שלום");
    expect(send.allowFreeform).toBe(false);
  });
});

describe("buildReminderSend — never invents a missing document that isn't real", () => {
  it("nothing actually missing -> falls back to the generic body, never a guessed list", async () => {
    const { conversationId, requestId } = await seedRequestWithMissingRequirement(2);
    // Waive the one requirement so nothing is genuinely missing.
    await db
      .update(schema.collectionRequestRequirements)
      .set({ exceptionStatus: "waived" })
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));

    const send = await buildReminderSend(conversationId, requestId, "רז שלום");
    expect(send.body).not.toContain("אישור שכירות");
  });
});
