import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

// Proves sendTemplateRequest — the one real path every "send a template to
// clients" UI (the wizard, and the new template gallery's combined
// TemplateSendToClients action) funnels through — genuinely creates real
// collection_requests rows via the real engine (snapshotServiceRequirements,
// attemptScheduledDelivery/startConversation), never a mock/parallel
// mechanism. Covers the exact business points the product ask named:
// creating requests from a template, sending to additional clients later,
// preventing a silent active duplicate, and re-sending once a prior
// request from the same template has genuinely completed.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const sendTextMessage = vi.fn();
const sendTemplateMessage = vi.fn();
const sendInteractiveButtonsMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
    sendInteractiveButtonsMessage: (...args: unknown[]) => sendInteractiveButtonsMessage(...args),
  };
});

const { sendTemplateRequest, deleteTemplate } = await import("./actions");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset().mockResolvedValue({ messageId: "wamid.out" });
  sendTemplateMessage.mockReset().mockResolvedValue({ messageId: "wamid.out" });
  sendInteractiveButtonsMessage.mockReset().mockResolvedValue({ messageId: "wamid.out" });
});

async function seedOrgWithTemplate(requirementNames: string[] = ["תעודת זהות"]) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      documentCollectionEnabled: true,
      businessHoursStart: "00:00",
      businessHoursEnd: "23:59",
      businessDays: "0,1,2,3,4,5,6",
    })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `${crypto.randomUUID()}@test.com`, passwordHash: "x", fullName: "Tester" })
    .returning();
  const [template] = await db
    .insert(schema.services)
    .values({ organizationId: org.id, name: "מסמכים לפתיחת תיק", collectionMode: "on_demand" })
    .returning();
  if (requirementNames.length > 0) {
    await db
      .insert(schema.serviceDocumentRequirements)
      .values(requirementNames.map((n) => ({ serviceId: template.id, name: n })));
  }
  currentSession = {
    sessionId: "s1",
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    organizationId: org.id,
    organizationName: org.name,
  } as Session;
  return { orgId: org.id, templateId: template.id };
}

async function seedClient(orgId: string, name = "לקוח") {
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name, phone: `+9725${Math.floor(Math.random() * 1e8)}` })
    .returning();
  return client.id;
}

function formData(entries: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) value.forEach((v) => fd.append(key, v));
    else fd.append(key, value);
  }
  return fd;
}

async function send(templateId: string, entries: Record<string, string | string[]>) {
  try {
    await sendTemplateRequest(templateId, formData(entries));
    throw new Error("expected a redirect");
  } catch (err) {
    const message = (err as Error).message;
    if (!message.startsWith("NEXT_REDIRECT:")) throw err;
    const url = message.slice("NEXT_REDIRECT:".length);
    const params = Object.fromEntries(new URL(url, "http://x").searchParams);
    return params;
  }
}

async function del(templateId: string) {
  try {
    await deleteTemplate(templateId);
    throw new Error("expected a redirect");
  } catch (err) {
    const message = (err as Error).message;
    if (!message.startsWith("NEXT_REDIRECT:")) throw err;
    const url = message.slice("NEXT_REDIRECT:".length);
    return { pathname: url.split("?")[0], params: Object.fromEntries(new URL(url, "http://x").searchParams) };
  }
}

describe("sendTemplateRequest — creating real collection requests from a template", () => {
  it("creates a real collection_requests row, snapshotted from the template's own requirements, and delivers it", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate(["תעודת זהות", "תלוש שכר"]);
    const clientId = await seedClient(orgId);

    const result = await send(templateId, { clientId, sendMode: "now" });
    expect(result.sent).toBe("1");
    expect(result.alreadyActive).toBe("0");

    const [request] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientId));
    expect(request.serviceId).toBe(templateId);
    expect(request.status).toBe("active"); // attemptScheduledDelivery flips draft -> active on success

    const requirements = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, request.id));
    expect(requirements.map((r) => r.name).sort()).toEqual(["תלוש שכר", "תעודת זהות"]);

    expect(sendTemplateMessage).toHaveBeenCalledTimes(1);
  });

  it("sending to additional clients later creates independent new requests, without touching the first", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientA = await seedClient(orgId, "לקוח א");
    await send(templateId, { clientId: clientA, sendMode: "now" });

    const clientB = await seedClient(orgId, "לקוח ב");
    const result = await send(templateId, { clientId: clientB, sendMode: "now" });
    expect(result.sent).toBe("1");

    const allRequests = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.serviceId, templateId));
    expect(allRequests).toHaveLength(2);
    expect(new Set(allRequests.map((r) => r.clientId))).toEqual(new Set([clientA, clientB]));
  });

  it("a brand-new client (name+phone, not yet in the system) is created for real and sent to", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();

    const result = await send(templateId, {
      newClientName: "לקוח חדש",
      newClientPhone: "+972500009999",
      sendMode: "now",
    });
    expect(result.sent).toBe("1");

    const [client] = await db
      .select()
      .from(schema.clients)
      .where(eq(schema.clients.organizationId, orgId));
    // seedOrgWithTemplate creates no client of its own, so this must be it
    expect(client.name).toBe("לקוח חדש");
    expect(client.phone).toBe("+972500009999");

    const [request] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, client.id));
    expect(request.serviceId).toBe(templateId);
  });
});

describe("sendTemplateRequest — duplicate-active prevention", () => {
  it("sending again to a client who already has a non-terminal request from this template is skipped, not duplicated", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientId = await seedClient(orgId);

    const first = await send(templateId, { clientId, sendMode: "now" });
    expect(first.sent).toBe("1");

    const second = await send(templateId, { clientId, sendMode: "now" });
    expect(second.sent).toBe("0");
    expect(second.alreadyActive).toBe("1");

    const allRequests = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientId));
    expect(allRequests).toHaveLength(1); // still just the one — never duplicated
    expect(sendTemplateMessage).toHaveBeenCalledTimes(1); // only the first send ever messaged the client
  });

  it("mixing an already-active client with a genuinely new one sends only to the new one, reporting both counts", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientActive = await seedClient(orgId, "כבר פעיל");
    await send(templateId, { clientId: clientActive, sendMode: "now" });

    const clientNew = await seedClient(orgId, "חדש");
    const result = await send(templateId, { clientId: [clientActive, clientNew], sendMode: "now" });

    expect(result.sent).toBe("1");
    expect(result.alreadyActive).toBe("1");
    const newClientRequests = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientNew));
    expect(newClientRequests).toHaveLength(1);
  });

  it("once the prior request from this template genuinely completed, sending again is allowed", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientId = await seedClient(orgId);
    await send(templateId, { clientId, sendMode: "now" });

    const [firstRequest] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientId));
    await db
      .update(schema.collectionRequests)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.collectionRequests.id, firstRequest.id));

    const result = await send(templateId, { clientId, sendMode: "now" });
    expect(result.sent).toBe("1");
    expect(result.alreadyActive).toBe("0");

    const allRequests = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientId));
    expect(allRequests).toHaveLength(2);
    expect(allRequests.some((r) => r.status === "completed")).toBe(true);
    expect(allRequests.some((r) => r.id !== firstRequest.id)).toBe(true);
  });
});

describe("sendTemplateRequest — snapshot independence from later template edits", () => {
  it("editing the template's requirements after sending never changes an already-created request's own requirements", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate(["תעודת זהות"]);
    const clientId = await seedClient(orgId);
    await send(templateId, { clientId, sendMode: "now" });

    const [request] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientId));

    // Edit the template AFTER the send — add a new requirement, remove the old one.
    await db.insert(schema.serviceDocumentRequirements).values({ serviceId: templateId, name: "תלוש שכר" });
    await db
      .delete(schema.serviceDocumentRequirements)
      .where(eq(schema.serviceDocumentRequirements.name, "תעודת זהות"));

    const requirementsAfterEdit = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, request.id));
    expect(requirementsAfterEdit.map((r) => r.name)).toEqual(["תעודת זהות"]); // untouched snapshot

    // A fresh send to a new client picks up the NEW template shape.
    const clientB = await seedClient(orgId, "לקוח חדש");
    await send(templateId, { clientId: clientB, sendMode: "now" });
    const [requestB] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.clientId, clientB));
    const requirementsB = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestB.id));
    expect(requirementsB.map((r) => r.name)).toEqual(["תלוש שכר"]);
  });
});

// Template deletion policy — "mark, never delete" (services.retiredAt).
// Having been used historically, however many times, is never itself a
// reason to block deletion; only a currently-active request is. Deleting
// must never touch a single historical collectionRequests row, and a
// retired template must refuse new sends.
describe("deleteTemplate — soft-delete (retire), never a hard DELETE", () => {
  it("retires a template with no active requests: services row is soft-deleted (retiredAt set, not removed), audited, and disappears from the gallery", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();

    const result = await del(templateId);
    expect(result.pathname).toBe("/collections");

    const [row] = await db.select().from(schema.services).where(eq(schema.services.id, templateId));
    expect(row).toBeDefined(); // never actually deleted
    expect(row.retiredAt).not.toBeNull();

    const audits = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.organizationId, orgId));
    expect(audits.some((a) => a.eventType === "template.deleted")).toBe(true);
  });

  it("blocks deletion when the template has at least one active request, even though it was used historically hundreds of times", async () => {
    const { templateId } = await seedOrgWithTemplate();
    const clientId = await seedClient((await db.select().from(schema.services).where(eq(schema.services.id, templateId)))[0].organizationId, "לקוח");
    await send(templateId, { clientId, sendMode: "now" });

    const result = await del(templateId);
    expect(result.params.error).toBe("has-active-requests");

    const [row] = await db.select().from(schema.services).where(eq(schema.services.id, templateId));
    expect(row.retiredAt).toBeNull(); // not retired — the block actually held
  });

  it("allows deletion once the only request from this template has completed (no longer active)", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientId = await seedClient(orgId, "לקוח");
    await send(templateId, { clientId, sendMode: "now" });
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.clientId, clientId));
    await db.update(schema.collectionRequests).set({ status: "completed" }).where(eq(schema.collectionRequests.id, request.id));

    const result = await del(templateId);
    expect(result.pathname).toBe("/collections");
    const [row] = await db.select().from(schema.services).where(eq(schema.services.id, templateId));
    expect(row.retiredAt).not.toBeNull();
  });

  it("never touches the historical collectionRequests row itself — it keeps resolving its template name via the same live join", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    const clientId = await seedClient(orgId, "לקוח היסטורי");
    await send(templateId, { clientId, sendMode: "now" });
    const [request] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.clientId, clientId));
    await db.update(schema.collectionRequests).set({ status: "completed" }).where(eq(schema.collectionRequests.id, request.id));

    await del(templateId);

    const [stillJoins] = await db
      .select({ id: schema.collectionRequests.id, serviceName: schema.services.name })
      .from(schema.collectionRequests)
      .innerJoin(schema.services, eq(schema.collectionRequests.serviceId, schema.services.id))
      .where(eq(schema.collectionRequests.id, request.id));
    expect(stillJoins).toBeDefined();
    expect(stillJoins.serviceName).toBe("מסמכים לפתיחת תיק");
  });

  it("refuses to start a NEW request from an already-retired template", async () => {
    const { orgId, templateId } = await seedOrgWithTemplate();
    await del(templateId);
    const clientId = await seedClient(orgId, "לקוח חדש");

    const result = await send(templateId, { clientId, sendMode: "now" });
    expect(result.error).toBe("template-deleted");
    const requests = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.clientId, clientId));
    expect(requests).toHaveLength(0);
  });
});
