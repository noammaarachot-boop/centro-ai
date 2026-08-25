import { beforeAll, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
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

const { listActivityHistory, groupActivityItems, ACTIVITY_CATEGORIES, CATEGORY_LABELS } = await import("./activityHistory");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
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

describe("emphasis tiers — visual weight only, never affects which events are shown", () => {
  it("a completed request is significant", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "collection_request.status_changed",
      description: "סטטוס בקשת האיסוף עודכן מ-processing ל-completed",
      actorType: "system",
      metadata: { from: "processing", to: "completed" },
    });
    const [item] = await listActivityHistory(orgId);
    expect(item.emphasis).toBe("significant");
  });

  it("a routine internal transition (processing) stays routine", async () => {
    const orgId = await seedOrg();
    await recordEvent({
      organizationId: orgId,
      eventType: "collection_request.status_changed",
      description: "סטטוס בקשת האיסוף עודכן מ-active ל-processing",
      actorType: "system",
      metadata: { from: "active", to: "processing" },
    });
    const [item] = await listActivityHistory(orgId);
    expect(item.emphasis).toBe("routine");
  });

  it("every failure-category event is critical or significant, never routine", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "whatsapp.send_failed", description: "נכשל", actorType: "system" });
    const [item] = await listActivityHistory(orgId);
    expect(item.category).toBe("failure");
    expect(item.emphasis).toBe("critical");
  });

  it("a rejected document is significant; an approved one is routine", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "document.reviewed", description: 'מסמך "תעודת זהות" סומן כנדחה על ידי עובד', actorType: "employee" });
    await recordEvent({ organizationId: orgId, eventType: "document.reviewed", description: 'מסמך "תעודת זהות" סומן כאושר על ידי עובד', actorType: "employee" });
    const items = await listActivityHistory(orgId);
    const rejected = items.find((i) => i.title.includes("נדחה"))!;
    const approved = items.find((i) => i.title.includes("אושר"))!;
    expect(rejected.emphasis).toBe("significant");
    expect(approved.emphasis).toBe("routine");
  });

  it("routine housekeeping (template created) stays routine", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "template.created", description: 'בקשת האיסוף "X" נוצרה', actorType: "employee" });
    const [item] = await listActivityHistory(orgId);
    expect(item.emphasis).toBe("routine");
  });
});

describe("no 'team' category — Centro is single-user today, but the real actor is still shown per event", () => {
  it("ACTIVITY_CATEGORIES has no 'team' entry", () => {
    expect(ACTIVITY_CATEGORIES).not.toContain("team");
    expect(Object.keys(CATEGORY_LABELS)).not.toContain("team");
  });

  it("employee.registered (a purely team/onboarding event) is excluded from this view entirely", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "employee.registered", description: "עובד נרשם", actorType: "employee" });
    expect(await listActivityHistory(orgId)).toHaveLength(0);
  });

  it("conversation.human_takeover is reassigned to 'request' (not dropped) and still shows the real actor", async () => {
    const orgId = await seedOrg();
    const [client] = await db.insert(schema.clients).values({ organizationId: orgId, name: "לקוח", phone: "+972500000010" }).returning();
    const [user] = await db.insert(schema.users).values({ organizationId: orgId, email: "e@test.com", passwordHash: "x", fullName: "עובד בדיקה" }).returning();
    await recordEvent({
      organizationId: orgId,
      eventType: "conversation.human_takeover",
      description: "עובד השתלט על השיחה",
      actorType: "employee",
      actorUserId: user.id,
      clientId: client.id,
    });
    const [item] = await listActivityHistory(orgId);
    expect(item.category).toBe("request");
    expect(item.actorName).toBe("עובד בדיקה"); // real actor preserved — audit-trail correctness, future-proof
  });

  it("review_item.opened is reassigned to 'whatsapp'", async () => {
    const orgId = await seedOrg();
    await recordEvent({ organizationId: orgId, eventType: "review_item.opened", description: 'נפתח פריט לבדיקת עובד: "שאלה"', actorType: "ai" });
    const [item] = await listActivityHistory(orgId);
    expect(item.category).toBe("whatsapp");
  });
});

describe("search matches raw ids too, not just names", () => {
  it("finds an event by its collectionRequestId", async () => {
    const orgId = await seedOrg();
    const [client] = await db.insert(schema.clients).values({ organizationId: orgId, name: "לקוח", phone: "+972500000011" }).returning();
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "שירות" }).returning();
    const [request] = await db.insert(schema.collectionRequests).values({ organizationId: orgId, clientId: client.id, serviceId: service.id, periodLabel: "p" }).returning();
    await recordEvent({ organizationId: orgId, eventType: "document.received", description: "מסמך התקבל", actorType: "client", collectionRequestId: request.id });

    const results = await listActivityHistory(orgId, { search: request.id });
    expect(results).toHaveLength(1);
  });

  it("finds a template event by its templateId (from metadata)", async () => {
    const orgId = await seedOrg();
    const [template] = await db.insert(schema.services).values({ organizationId: orgId, name: "תבנית", collectionMode: "on_demand" }).returning();
    await recordEvent({ organizationId: orgId, eventType: "template.deleted", description: 'התבנית "תבנית" נמחקה', actorType: "employee", metadata: { templateId: template.id } });

    const results = await listActivityHistory(orgId, { search: template.id });
    expect(results).toHaveLength(1);
  });
});

describe("groupActivityItems — visual grouping only, never a server-side dedup", () => {
  function makeItem(overrides: Partial<Awaited<ReturnType<typeof listActivityHistory>>[number]>): Awaited<ReturnType<typeof listActivityHistory>>[number] {
    return {
      id: crypto.randomUUID(),
      category: "template",
      emphasis: "routine",
      title: 'התבנית "מסמכים לפתיחת תיק" נמחקה',
      occurredAt: new Date(),
      actorType: "employee",
      actorName: null,
      clientId: null,
      clientName: null,
      collectionRequestId: null,
      requestLabel: null,
      templateId: null,
      templateName: null,
      technicalDetail: null,
      ...overrides,
    };
  }

  it("collapses consecutive identical-title events within the grouping window into one group, keeping every real item", () => {
    const now = Date.now();
    const items = [
      makeItem({ id: "1", occurredAt: new Date(now) }),
      makeItem({ id: "2", occurredAt: new Date(now - 3_000) }),
      makeItem({ id: "3", occurredAt: new Date(now - 7_000) }),
    ];
    const groups = groupActivityItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["1", "2", "3"]); // every real item preserved, in order
    expect(groups[0].item.id).toBe("1"); // representative = newest
  });

  it("never groups events with different titles, even if adjacent in time", () => {
    const now = Date.now();
    const items = [
      makeItem({ id: "1", title: "A", occurredAt: new Date(now) }),
      makeItem({ id: "2", title: "B", occurredAt: new Date(now - 1_000) }),
    ];
    const groups = groupActivityItems(items);
    expect(groups).toHaveLength(2);
  });

  it("never groups events with the same title but different categories", () => {
    const now = Date.now();
    const items = [
      makeItem({ id: "1", title: "same", category: "template", occurredAt: new Date(now) }),
      makeItem({ id: "2", title: "same", category: "document", occurredAt: new Date(now - 1_000) }),
    ];
    const groups = groupActivityItems(items);
    expect(groups).toHaveLength(2);
  });

  it("does not group identical titles far apart in time (outside the grouping window)", () => {
    const now = Date.now();
    const items = [
      makeItem({ id: "1", occurredAt: new Date(now) }),
      makeItem({ id: "2", occurredAt: new Date(now - 60 * 60 * 1000) }), // 1 hour earlier
    ];
    const groups = groupActivityItems(items);
    expect(groups).toHaveLength(2);
  });

  it("a single, non-repeated event is its own group of one", () => {
    const groups = groupActivityItems([makeItem({ id: "1" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(1);
  });

  it("real production shape: 10 identically-named template.deleted events all group together, none lost", () => {
    const now = Date.now();
    const items = Array.from({ length: 10 }, (_, i) => makeItem({ id: String(i), occurredAt: new Date(now - i * 4_000) }));
    const groups = groupActivityItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(10);
    expect(new Set(groups[0].items.map((i) => i.id)).size).toBe(10); // all distinct, nothing collapsed away
  });
});
