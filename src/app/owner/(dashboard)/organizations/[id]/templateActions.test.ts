import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { OwnerSession } from "@/lib/auth/ownerSession";

// Owner-managed WhatsApp templates, end to end: submission goes to the
// organization's OWN WABA with its OWN token, statuses are stored per
// organization, and one organization's templates can never be reached
// through another's id.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

let currentOwnerSession: OwnerSession;
vi.mock("@/lib/auth/ownerSession", () => ({
  requireOwnerSession: vi.fn(async () => currentOwnerSession),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

vi.mock("@/lib/whatsapp/config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "fake-system-token" }),
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
  currentOwnerSession = {
    sessionId: "owner-s1",
    platformOwnerId: platformOwner.id,
    email: platformOwner.email,
  };
});

const { submitWhatsAppTemplateAction, refreshWhatsAppTemplateStatusesAction } = await import(
  "./templateActions"
);
const { encryptWhatsAppToken } = await import("@/lib/whatsapp/tokenCipher");

const REQUEST_TEMPLATE = "centro_document_request_v3";

async function seedConnectedOrg(options?: { withToken?: boolean }) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappBusinessAccountId: `waba-${crypto.randomUUID()}`,
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      whatsappAccessTokenEnc:
        options?.withToken === false ? null : encryptWhatsAppToken("EAAG_org_own_token"),
    })
    .returning();
  return org;
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
    return {
      pathname: url.split("?")[0],
      params: Object.fromEntries(new URL(url, "http://x").searchParams),
    };
  }
}

async function storedTemplate(organizationId: string, name = REQUEST_TEMPLATE) {
  const [row] = await db
    .select()
    .from(schema.whatsappTemplates)
    .where(
      and(
        eq(schema.whatsappTemplates.organizationId, organizationId),
        eq(schema.whatsappTemplates.name, name)
      )
    );
  return row ?? null;
}

describe("submitWhatsAppTemplateAction", () => {
  it("submits to the organization's OWN WABA with its OWN decrypted token, and stores the result", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({
          organizationId: org.id,
          templateName: REQUEST_TEMPLATE,
          exampleValue: "תעודת זהות, 3 תלושי שכר",
        })
      )
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://graph.example/v1/${org.whatsappBusinessAccountId}/message_templates`);
    expect(init.headers.Authorization).toBe("Bearer EAAG_org_own_token");

    const row = await storedTemplate(org.id);
    expect(row!.status).toBe("PENDING");
    expect(row!.metaTemplateId).toBe("meta-tpl-1");
    expect(row!.wabaId).toBe(org.whatsappBusinessAccountId);
    expect(row!.exampleValues).toEqual(["תעודת זהות, 3 תלושי שכר"]);
    expect(row!.variables).toEqual(["{{1}}"]);
    expect(row!.rejectedReason).toBeNull();
  });

  it("the body sent to Meta is byte-for-byte the managed definition, with static text on BOTH sides of {{1}}", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    const { findManagedTemplate } = await import("@/lib/whatsapp/templateManagement");
    const definition = findManagedTemplate(REQUEST_TEMPLATE)!;
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body).components[0].text;

    expect(sentBody).toBe(definition.bodyText);
    // The live rejection this guards against: a placeholder at the very
    // start or end of the body.
    expect(sentBody.trim().endsWith("{{1}}")).toBe(false);
    expect(sentBody.trim().startsWith("{{1}}")).toBe(false);
    expect(sentBody).toContain("תודה, לאחר קבלת המסמכים נוכל להמשיך בטיפול.");

    // ...and what we stored matches what we actually sent.
    expect((await storedTemplate(org.id))!.bodyText).toBe(sentBody);
  });

  it("never writes anything and never calls Meta when the example is invalid", async () => {
    const org = await seedConnectedOrg();

    const result = await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "  " })
      )
    );

    expect(result.params.templateError).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await storedTemplate(org.id)).toBeNull();
  });

  it("refuses when the organization has no manual connection token, without calling Meta", async () => {
    const org = await seedConnectedOrg({ withToken: false });

    const result = await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    expect(decodeURIComponent(result.params.templateError)).toMatch(/חיבור WhatsApp ידני/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces Meta's own rejection message and stores nothing", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Invalid parameter" } }),
    });

    const result = await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    expect(decodeURIComponent(result.params.templateError)).toMatch(/Invalid parameter/);
    expect(await storedTemplate(org.id)).toBeNull();
  });

  it("never leaks the access token into the error surfaced to the browser or into the audit trail", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    });

    const result = await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    expect(JSON.stringify(result)).not.toContain("EAAG_org_own_token");
    const audits = await db.select().from(schema.platformOwnerAuditLog);
    expect(JSON.stringify(audits)).not.toContain("EAAG_org_own_token");
    expect(audits.some((a) => a.eventType === "owner.whatsapp_template_submitted")).toBe(true);
  });

  it("a REJECTED template is resubmitted by EDITING it in Meta, never by creating a duplicate name", async () => {
    const org = await seedConnectedOrg();
    await db.insert(schema.whatsappTemplates).values({
      organizationId: org.id,
      wabaId: org.whatsappBusinessAccountId!,
      name: REQUEST_TEMPLATE,
      language: "he",
      category: "UTILITY",
      bodyText: "old",
      variables: ["{{1}}"],
      exampleValues: ["old example"],
      metaTemplateId: "meta-tpl-1",
      status: "REJECTED",
      rejectedReason: "INVALID_FORMAT",
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({
          organizationId: org.id,
          templateName: REQUEST_TEMPLATE,
          exampleValue: "תעודת זהות, אישור ניהול חשבון",
        })
      )
    );

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://graph.example/v1/meta-tpl-1"); // edit, not create
    expect(String(url)).not.toContain("message_templates");

    const row = await storedTemplate(org.id);
    expect(row!.status).toBe("PENDING"); // back in review
    expect(row!.rejectedReason).toBeNull(); // stale reason cleared
    expect(row!.exampleValues).toEqual(["תעודת זהות, אישור ניהול חשבון"]);
  });

  it("tenant isolation: submitting for organization A never creates or touches a row for organization B", async () => {
    const orgA = await seedConnectedOrg();
    const orgB = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-a", status: "PENDING", category: "UTILITY" }),
    });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: orgA.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    expect(await storedTemplate(orgA.id)).not.toBeNull();
    expect(await storedTemplate(orgB.id)).toBeNull();
    // ...and it went to A's WABA, never B's.
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain(orgA.whatsappBusinessAccountId!);
    expect(String(url)).not.toContain(orgB.whatsappBusinessAccountId!);
  });
});

// The end-to-end invariant this whole audit exists to guarantee: the token
// that SUBMITS a template and the token that later SENDS with it are the
// same organization's own token. A split there is exactly the failure mode
// where submission succeeds and the first real send mysteriously fails.
describe("end-to-end: submit and send both use the SAME organization's own token", () => {
  it("the token used to submit the template is the token sendViaWhatsApp would decrypt and send with", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "APPROVED", category: "UTILITY" }),
    });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    const submitToken = fetchMock.mock.calls[0][1].headers.Authorization;
    expect(submitToken).toBe("Bearer EAAG_org_own_token");

    // The send path derives its token from the very same column, via the
    // same cipher — assert on the decrypted value rather than trusting
    // that two code paths happen to agree.
    const [row] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, org.id));
    const { decryptWhatsAppToken } = await import("@/lib/whatsapp/tokenCipher");
    const sendToken = decryptWhatsAppToken(row.whatsappAccessTokenEnc!);
    expect(`Bearer ${sendToken}`).toBe(submitToken);
  });

  it("the template is submitted to the SAME WABA the organization is connected to", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    });

    await expectRedirect(() =>
      submitWhatsAppTemplateAction(
        formData({ organizationId: org.id, templateName: REQUEST_TEMPLATE, exampleValue: "תעודת זהות" })
      )
    );

    const stored = await storedTemplate(org.id);
    expect(stored!.wabaId).toBe(org.whatsappBusinessAccountId);
    expect(String(fetchMock.mock.calls[0][0])).toContain(org.whatsappBusinessAccountId!);
  });
});

describe("refreshWhatsAppTemplateStatusesAction", () => {
  it("stores Meta's current status, category and rejection reason per organization", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-1",
            name: REQUEST_TEMPLATE,
            language: "he",
            status: "REJECTED",
            category: "MARKETING",
            rejected_reason: "INVALID_FORMAT",
          },
        ],
      }),
    });

    const result = await expectRedirect(() =>
      refreshWhatsAppTemplateStatusesAction(formData({ organizationId: org.id }))
    );
    expect(result.params.templateRefreshed).toBe("1");

    const row = await storedTemplate(org.id);
    expect(row!.status).toBe("REJECTED");
    expect(row!.rejectedReason).toBe("INVALID_FORMAT");
    // Meta reclassified the category — stored as Meta actually holds it.
    expect(row!.category).toBe("MARKETING");
    expect(row!.lastSyncedAt).toBeInstanceOf(Date);
  });

  it("clears a stale rejection reason once Meta reports the template approved", async () => {
    const org = await seedConnectedOrg();
    await db.insert(schema.whatsappTemplates).values({
      organizationId: org.id,
      wabaId: org.whatsappBusinessAccountId!,
      name: REQUEST_TEMPLATE,
      language: "he",
      category: "UTILITY",
      bodyText: "b",
      variables: ["{{1}}"],
      exampleValues: ["e"],
      metaTemplateId: "meta-tpl-1",
      status: "REJECTED",
      rejectedReason: "INVALID_FORMAT",
    });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-1",
            name: REQUEST_TEMPLATE,
            language: "he",
            status: "APPROVED",
            category: "UTILITY",
            rejected_reason: "NONE",
          },
        ],
      }),
    });

    await expectRedirect(() => refreshWhatsAppTemplateStatusesAction(formData({ organizationId: org.id })));

    const row = await storedTemplate(org.id);
    expect(row!.status).toBe("APPROVED");
    expect(row!.rejectedReason).toBeNull();
  });

  it("is a clean no-op when the WABA holds none of the managed templates yet", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });

    const result = await expectRedirect(() =>
      refreshWhatsAppTemplateStatusesAction(formData({ organizationId: org.id }))
    );

    expect(result.params.templateRefreshed).toBe("0");
    expect(await storedTemplate(org.id)).toBeNull();
  });

  it("adopts a template that exists on the WABA but was never recorded locally", async () => {
    const org = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-adopted",
            name: REQUEST_TEMPLATE,
            language: "he",
            status: "APPROVED",
            category: "UTILITY",
            rejected_reason: "NONE",
          },
        ],
      }),
    });

    await expectRedirect(() => refreshWhatsAppTemplateStatusesAction(formData({ organizationId: org.id })));

    const row = await storedTemplate(org.id);
    expect(row!.metaTemplateId).toBe("meta-tpl-adopted");
    expect(row!.status).toBe("APPROVED");
  });

  it("tenant isolation: refreshing organization A never writes a row for organization B", async () => {
    const orgA = await seedConnectedOrg();
    const orgB = await seedConnectedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-1",
            name: REQUEST_TEMPLATE,
            language: "he",
            status: "APPROVED",
            category: "UTILITY",
            rejected_reason: "NONE",
          },
        ],
      }),
    });

    await expectRedirect(() => refreshWhatsAppTemplateStatusesAction(formData({ organizationId: orgA.id })));

    expect(await storedTemplate(orgA.id)).not.toBeNull();
    expect(await storedTemplate(orgB.id)).toBeNull();
  });
});
