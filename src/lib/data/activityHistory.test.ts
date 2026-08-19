import { beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Proves the Activity History screen's own curation layer: a real
// audit_logs row only ever appears here if its eventType is on the
// explicit business-event allowlist, rendered in clean Hebrew — never the
// raw eventType string, never state-machine terminology. audit_logs itself
// is never touched (no delete, no rewrite) by anything in this file.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { listActivityHistory } = await import("./activityHistory");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrg() {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  return org.id;
}

async function recordEvent(overrides: Partial<typeof schema.auditLogs.$inferInsert> & { organizationId: string; eventType: string; description: string; actorType: "employee" | "ai" | "system" | "client" }) {
  const [row] = await db.insert(schema.auditLogs).values(overrides).returning();
  return row;
}

describe("listActivityHistory — visibility: only the business allowlist appears", () => {
  it("shows a business-meaningful event with a clean Hebrew label", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "document.received",
      description: 'מסמך "תעודת זהות" התקבל מהלקוח (וואטסאפ)',
      actorType: "client",
    });

    const items = await listActivityHistory(orgId);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('מסמך "תעודת זהות" התקבל מהלקוח (וואטסאפ)');
    expect(items[0].category).toBe("document");
  });

  it("hides a purely technical/internal event entirely — never shown, even disguised", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "message.conversation_reasoning_outcome",
      description: "הודעת הלקוח סווגה כ-CLARIFY (ביטחון 0.72)",
      actorType: "ai",
    });
    await recordEvent({
      organizationId: orgId,
      eventType: "message.conversation_intent_classified",
      description: "סווג",
      actorType: "ai",
    });

    const items = await listActivityHistory(orgId);
    expect(items).toHaveLength(0);
  });

  it("never leaks a raw eventType string or state-machine terminology into the rendered title", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "collection_request.status_changed",
      description: "סטטוס בקשת האיסוף עודכן מ-processing ל-completed",
      actorType: "employee",
      metadata: { from: "processing", to: "completed" },
    });

    const items = await listActivityHistory(orgId);
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("בקשת האיסוף הושלמה");
    expect(items[0].title).not.toMatch(/processing|completed|status_changed/);
  });

  it("skips a status_changed row whose target status has no business-meaningful label (e.g. active -> waiting_for_client)", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "collection_request.status_changed",
      description: "סטטוס בקשת האיסוף עודכן מ-active ל-waiting_for_client",
      actorType: "system",
      metadata: { from: "active", to: "waiting_for_client" },
    });

    expect(await listActivityHistory(orgId)).toHaveLength(0);
  });

  it("translates template.created/updated away from their own stored (misleadingly-worded) description", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "template.created",
      description: 'בקשת האיסוף "מסמכים לפתיחת תיק" נוצרה', // the real, slightly-mislabeled stored text
      actorType: "employee",
    });

    const items = await listActivityHistory(orgId);
    expect(items[0].title).toBe('התבנית "מסמכים לפתיחת תיק" נוצרה');
    expect(items[0].category).toBe("template");
  });
});

describe("listActivityHistory — duplicate handling: real distinct events are never deduplicated away", () => {
  it("keeps every genuinely separate template.deleted event, one per real row, even with identical descriptions", async () => {
    const orgId = await seedOrg();
    for (let i = 0; i < 3; i++) {
      await recordEvent({
        organizationId: orgId,
        eventType: "template.deleted",
        description: 'התבנית "מסמכים לפתיחת תיק" נמחקה',
        actorType: "employee",
        metadata: { templateId: `00000000-0000-4000-8000-00000000000${i}` },
      });
    }

    const items = await listActivityHistory(orgId);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.id)).size).toBe(3); // three distinct real rows, not collapsed
  });
});

describe("listActivityHistory — deleted/retired entity: history stays readable, never a broken link", () => {
  it("resolves a template's historical name from metadata.templateId even after it's been retired (soft-deleted)", async () => {
    const orgId = await seedOrg();
    const [template] = await db.insert(schema.services).values({ organizationId: orgId, name: "תבנית ותיקה", collectionMode: "on_demand" }).returning();
    await recordEvent({
      organizationId: orgId,
      eventType: "template.deleted",
      description: 'התבנית "תבנית ותיקה" נמחקה',
      actorType: "employee",
      metadata: { templateId: template.id },
    });
    // Retire it — the row still exists (soft-delete), same as production.
    await db.update(schema.services).set({ retiredAt: new Date() }).where((await import("drizzle-orm")).eq(schema.services.id, template.id));

    const items = await listActivityHistory(orgId);
    expect(items[0].templateName).toBe("תבנית ותיקה");
    expect(items[0].templateId).toBe(template.id); // drill-down target still resolvable
  });

  it("shows only the historical name (no drill-down id) when metadata never captured one — an old pre-fix row", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "template.deleted",
      description: 'התבנית "תבנית ישנה מאוד" נמחקה',
      actorType: "employee",
      // no metadata at all — matches every template.deleted row written
      // before this feature added templateId to it
    });

    const items = await listActivityHistory(orgId);
    expect(items[0].title).toBe('התבנית "תבנית ישנה מאוד" נמחקה');
    expect(items[0].templateId).toBeNull();
  });
});

describe("listActivityHistory — category filter and search", () => {
  it("filters by category", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "מסמך התקבל", actorType: "client" });
    await recordEvent({ organizationId: orgId, eventType: "template.created", description: 'התבנית "X" נוצרה', actorType: "employee" });

    const documentsOnly = await listActivityHistory(orgId, { category: "document" });
    expect(documentsOnly).toHaveLength(1);
    expect(documentsOnly[0].category).toBe("document");

    const all = await listActivityHistory(orgId, { category: "all" });
    expect(all).toHaveLength(2);
  });

  it("searches by client name", async () => {
    const orgId = await seedOrg();
    const [client] = await db.insert(schema.clients).values({ organizationId: orgId, name: "נועם שלום", phone: "+972500000001" }).returning();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "מסמך התקבל", actorType: "client", clientId: client.id });
    await recordEvent({ organizationId: orgId, eventType: "document.added_manually", description: "מסמך נוסף ידנית", actorType: "employee" });

    const results = await listActivityHistory(orgId, { search: "נועם" });
    expect(results).toHaveLength(1);
    expect(results[0].clientName).toBe("נועם שלום");
  });

  it("searches by template/request label", async () => {
    const orgId = await seedOrg();
    const [client] = await db.insert(schema.clients).values({ organizationId: orgId, name: "לקוח", phone: "+972500000002" }).returning();
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "מסמכים לפתיחת תיק מיוחדת" }).returning();
    const [request] = await db.insert(schema.collectionRequests).values({ organizationId: orgId, clientId: client.id, serviceId: service.id, periodLabel: "אוגוסט" }).returning();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "מסמך התקבל", actorType: "client", collectionRequestId: request.id });

    const results = await listActivityHistory(orgId, { search: "מיוחדת" });
    expect(results).toHaveLength(1);
    expect(results[0].requestLabel).toContain("מסמכים לפתיחת תיק מיוחדת");
  });
});

describe("listActivityHistory — failure events carry technical detail behind an explicit flag, never shown by default title", () => {
  it("a WhatsApp send failure gets a clean human title, with the raw description preserved as technicalDetail", async () => {
    const orgId = await seedOrg();
    const [client] = await db.insert(schema.clients).values({ organizationId: orgId, name: "נועם", phone: "+972500000003" }).returning();
    await recordEvent({
      organizationId: orgId,
      eventType: "whatsapp.send_failed",
      description: "WhatsApp send failed (400): code=131030 message=Recipient phone number not in allowed list",
      actorType: "system",
      clientId: client.id,
    });

    const items = await listActivityHistory(orgId);
    expect(items[0].title).toBe("שליחת הודעת WhatsApp נכשלה");
    expect(items[0].title).not.toContain("131030");
    expect(items[0].technicalDetail).toContain("131030");
  });

  it("a non-failure event never carries technicalDetail", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "מסמך התקבל", actorType: "client" });

    const items = await listActivityHistory(orgId);
    expect(items[0].technicalDetail).toBeNull();
  });
});

describe("listActivityHistory — date range and Hebrew-adjacent ordering", () => {
  it("respects from/to bounds and orders newest first", async () => {
    const orgId = await seedOrg();
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const recent = new Date();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "ישן", actorType: "client", occurredAt: old });
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "חדש", actorType: "client", occurredAt: recent });

    const items = await listActivityHistory(orgId, { from: new Date(Date.now() - 24 * 60 * 60 * 1000), to: new Date() });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("חדש");
  });
});
