import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import {
  appendUserMessage,
  createConversation,
  loadConversationHistory,
  listMessagesForDisplay,
} from "./persistence";

// Phase 5.1 remediation — none of these three functions used to take
// organizationId into account when reading/writing aiMessages by
// conversationId alone; every real call site already only reaches a
// conversationId that's pre-validated against the caller's own org (see
// this module's own top-of-file comment), so this proves the enforcement
// itself, not a live production leak.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrgWithUser(name: string) {
  const [org] = await db.insert(schema.organizations).values({ name }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `${crypto.randomUUID()}@example.com`, passwordHash: "hash" })
    .returning();
  return { orgId: org.id, userId: user.id };
}

describe("loadConversationHistory / listMessagesForDisplay — organizationId isolation", () => {
  it("never returns another organization's messages, even for a real conversationId", async () => {
    const { orgId: orgA, userId: userA } = await seedOrgWithUser("Org A");
    const { orgId: orgB } = await seedOrgWithUser("Org B");
    const conversation = await createConversation(orgA, userA);
    await appendUserMessage(conversation.id, orgA, "שלום");

    const asOwner = await loadConversationHistory(conversation.id, orgA);
    expect(asOwner).toHaveLength(1);

    const asOtherOrg = await loadConversationHistory(conversation.id, orgB);
    expect(asOtherOrg).toHaveLength(0);

    const displayAsOwner = await listMessagesForDisplay(conversation.id, orgA);
    expect(displayAsOwner).toHaveLength(1);

    const displayAsOtherOrg = await listMessagesForDisplay(conversation.id, orgB);
    expect(displayAsOtherOrg).toHaveLength(0);
  });
});

describe("appendUserMessage — organizationId enforcement", () => {
  it("refuses to write a message under a conversationId that belongs to a different organization", async () => {
    const { orgId: orgA, userId: userA } = await seedOrgWithUser("Org C");
    const { orgId: orgB } = await seedOrgWithUser("Org D");
    const conversation = await createConversation(orgA, userA);

    await expect(appendUserMessage(conversation.id, orgB, "טקסט")).rejects.toThrow(/not found/);

    const rows = await db.select().from(schema.aiMessages).where(eq(schema.aiMessages.conversationId, conversation.id));
    expect(rows).toHaveLength(0); // nothing was written under the wrong org
  });

  it("still works exactly as before for the legitimate owning organization", async () => {
    const { orgId, userId } = await seedOrgWithUser("Org E");
    const conversation = await createConversation(orgId, userId);

    await appendUserMessage(conversation.id, orgId, "הודעה ראשונה");

    const [updated] = await db.select().from(schema.aiConversations).where(eq(schema.aiConversations.id, conversation.id));
    expect(updated.title).toBe("הודעה ראשונה"); // still auto-derives the title on the first message
  });
});
