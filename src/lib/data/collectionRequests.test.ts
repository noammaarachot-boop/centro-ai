import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { ATTACHMENT_PLACEHOLDER_TEXT, resolveDocumentDisplayLabel, resolveMessageDisplayBody } from "@/lib/documents/displayLabel";

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { listDocumentsByWhatsappMessageId } = await import("./collectionRequests");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedRequest() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  return { orgId: org.id, requestId: request.id, requirementId: requirement.id };
}

describe("listDocumentsByWhatsappMessageId — feeds the conversation thread's display-time upgrade", () => {
  it("returns every real WhatsApp-attachment document for the request, with its resolved-label ingredients", async () => {
    const { orgId, requestId, requirementId } = await seedRequest();

    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      status: "approved",
      fileName: "image_wamid.HBgM.jpg",
      displayLabel: "תעודת זהות",
      whatsappMessageId: "wamid.1",
    });
    // A manual/simulated document with no whatsappMessageId — must be
    // excluded (there's no message thread entry to upgrade for it).
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      status: "approved",
      fileName: "manual-upload.pdf",
    });

    const rows = await listDocumentsByWhatsappMessageId(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ whatsappMessageId: "wamid.1", displayLabel: "תעודת זהות", requirementId });
  });

  it("includes a document with no displayLabel yet (still unclassified) — the caller resolves the fallback", async () => {
    const { orgId, requestId } = await seedRequest();
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      status: "needs_review",
      fileName: "image_wamid.HBgM2.jpg",
      whatsappMessageId: "wamid.2",
    });

    const rows = await listDocumentsByWhatsappMessageId(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0].displayLabel).toBeNull();
  });
});

describe("full thread-display pipeline — messages.whatsappMessageId is now actually populated for inbound rows", () => {
  it("a new inbound attachment message (placeholder body, real whatsappMessageId) upgrades to the document's real displayLabel", async () => {
    const { orgId, requestId, requirementId } = await seedRequest();
    const wamid = "wamid.new-inbound-1";

    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      status: "approved",
      fileName: "image_wamid.new-inbound-1.jpg",
      displayLabel: "תעודת זהות",
      whatsappMessageId: wamid,
    });
    // Mirrors what recordInboundMessage now writes (conversationOrchestration.ts)
    // for a real WhatsApp attachment — the same wamid on both rows.
    const rows = await listDocumentsByWhatsappMessageId(requestId);
    const label = resolveDocumentDisplayLabel(rows[0].displayLabel);
    const displayBody = resolveMessageDisplayBody(ATTACHMENT_PLACEHOLDER_TEXT, label);

    expect(displayBody).toBe("[קובץ מצורף: תעודת זהות]");
    expect(displayBody).not.toMatch(/wamid|\.(jpg|jpeg|png|pdf)/i);
  });

  it("a legacy raw-filename message (real production shape) resolves to the matched requirement's name, never the raw filename", async () => {
    const { orgId, requestId, requirementId } = await seedRequest(); // requirement: "תעודת זהות"
    const wamid = "wamid.HBgMOTcyNTU5ODU4Njg1FQIAEhgUMkFBMDgxMjIxNEM4NTUzMjM5NzMA";
    const legacyBody = `[קובץ: image_wamid.${wamid}.jpg]`;

    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      status: "approved",
      fileName: `image_wamid.${wamid}.jpg`,
      displayLabel: null, // pre-migration document, never backfilled
      whatsappMessageId: wamid,
    });

    const rows = await listDocumentsByWhatsappMessageId(requestId);
    const requirementName = "תעודת זהות";
    const label = resolveDocumentDisplayLabel(rows[0].displayLabel, requirementName);
    const displayBody = resolveMessageDisplayBody(legacyBody, label);

    expect(displayBody).toBe("[קובץ מצורף: תעודת זהות]");
    expect(displayBody).not.toContain(wamid);
    expect(displayBody).not.toMatch(/\.(jpg|jpeg|png|pdf)/i);
  });
});
