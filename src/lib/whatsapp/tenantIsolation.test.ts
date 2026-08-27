import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { encryptWhatsAppToken } from "@/lib/whatsapp/tokenCipher";

/**
 * Tenant isolation for WhatsApp — the property the per-organization resolver
 * exists to guarantee.
 *
 * Centro is multi-tenant: every office connects its own WABA, phone number
 * and token, and approves its own templates on its own Meta account. The
 * send path used to ask Meta for a hardcoded template name gated on a
 * hand-set boolean, so "approved" was a property of the codebase rather than
 * of the office — which is how one organization could send with a name only
 * another one had ever had approved.
 *
 * These assert that A never reaches anything belonging to B, INCLUDING when
 * A has nothing of its own: missing must fail, never borrow.
 */

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { resolveApprovedTemplate, resolveOrganizationWhatsAppConfig, resolveTemplateSendContext } =
  await import("./organizationWhatsApp");

beforeAll(async () => {
  // Same fixed key the other token-handling suites use.
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgA: string;
let orgB: string;

beforeEach(async () => {
  await db.delete(schema.whatsappTemplates);
  await db.delete(schema.organizations);

  const [a] = await db
    .insert(schema.organizations)
    .values({
      name: "Office A",
      whatsappBusinessAccountId: "waba-A",
      whatsappPhoneNumberId: "phone-A",
      whatsappAccessTokenEnc: encryptWhatsAppToken("token-A"),
    })
    .returning();
  const [b] = await db
    .insert(schema.organizations)
    .values({
      name: "Office B",
      whatsappBusinessAccountId: "waba-B",
      whatsappPhoneNumberId: "phone-B",
      whatsappAccessTokenEnc: encryptWhatsAppToken("token-B"),
    })
    .returning();
  orgA = a.id;
  orgB = b.id;

  // Only B has an approved template.
  await db.insert(schema.whatsappTemplates).values({
    organizationId: orgB,
    wabaId: "waba-B",
    intent: "DOCUMENT_REMINDER",
    name: "centro_document_reminder_v3",
    language: "he",
    category: "UTILITY",
    bodyText: "שלום, חסרים: {{1}}. תודה.",
    variables: ["{{1}}"],
    exampleValues: ["תעודת זהות"],
    metaTemplateId: "meta-B",
    status: "APPROVED",
  });
});

describe("credentials never cross organizations", () => {
  it("each organization resolves to its OWN waba, phone and token", async () => {
    const a = await resolveOrganizationWhatsAppConfig(orgA);
    const b = await resolveOrganizationWhatsAppConfig(orgB);

    expect(a.ok && a.config.wabaId).toBe("waba-A");
    expect(a.ok && a.config.phoneNumberId).toBe("phone-A");
    expect(a.ok && a.config.accessToken).toBe("token-A");
    expect(b.ok && b.config.wabaId).toBe("waba-B");
    expect(b.ok && b.config.phoneNumberId).toBe("phone-B");
    expect(b.ok && b.config.accessToken).toBe("token-B");
  });

  it("an organization with no phone number FAILS rather than borrowing one", async () => {
    await db
      .update(schema.organizations)
      .set({ whatsappPhoneNumberId: null })
      .where(eq(schema.organizations.id, orgA));

    const a = await resolveOrganizationWhatsAppConfig(orgA);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.problem).toBe("not_connected");

    const b = await resolveOrganizationWhatsAppConfig(orgB);
    expect(b.ok && b.config.phoneNumberId, "B is untouched").toBe("phone-B");
  });

  it("an unreadable token FAILS instead of falling through to the shared one", async () => {
    await db
      .update(schema.organizations)
      .set({ whatsappAccessTokenEnc: "not-decryptable" })
      .where(eq(schema.organizations.id, orgA));

    const a = await resolveOrganizationWhatsAppConfig(orgA);
    expect(a.ok, "a broken token must never silently become Centro's own").toBe(false);
  });

  it("an Embedded Signup organization is marked as using the shared credential, not another tenant's", async () => {
    await db
      .update(schema.organizations)
      .set({ whatsappAccessTokenEnc: null })
      .where(eq(schema.organizations.id, orgA));

    const a = await resolveOrganizationWhatsAppConfig(orgA);
    expect(a.ok).toBe(true);
    expect(a.ok && a.config.tokenSource).toBe("tech_provider");
    // Still A's own account — only the credential is Centro's Tech Provider.
    expect(a.ok && a.config.phoneNumberId).toBe("phone-A");
    expect(a.ok && a.config.wabaId).toBe("waba-A");
    expect(a.ok && a.config.accessToken, "never another organization's token").toBeUndefined();
  });
});

describe("templates never cross organizations", () => {
  it("A cannot read B's approved template, even though B has one", async () => {
    const a = await resolveApprovedTemplate(orgA, "DOCUMENT_REMINDER");

    expect(a.ok).toBe(false);
    expect(!a.ok && a.problem).toBe("no_template");
  });

  it("B resolves its own", async () => {
    const b = await resolveApprovedTemplate(orgB, "DOCUMENT_REMINDER");

    expect(b.ok && b.template.name).toBe("centro_document_reminder_v3");
    expect(b.ok && b.template.metaTemplateId).toBe("meta-B");
    expect(b.ok && b.template.wabaId).toBe("waba-B");
  });

  it("a template that is not APPROVED is refused, never downgraded to another one", async () => {
    await db
      .update(schema.whatsappTemplates)
      .set({ status: "PENDING" })
      .where(eq(schema.whatsappTemplates.organizationId, orgB));

    const b = await resolveApprovedTemplate(orgB, "DOCUMENT_REMINDER");
    expect(b.ok).toBe(false);
    expect(!b.ok && b.problem).toBe("template_not_approved");
    expect(!b.ok && b.status).toBe("PENDING");
  });

  it("MISSING — deleted on Meta's side — is refused too", async () => {
    await db
      .update(schema.whatsappTemplates)
      .set({ status: "MISSING" })
      .where(eq(schema.whatsappTemplates.organizationId, orgB));

    expect((await resolveApprovedTemplate(orgB, "DOCUMENT_REMINDER")).ok).toBe(false);
  });

  it("resolves by intent, so an office that renamed its template still works", async () => {
    await db
      .update(schema.whatsappTemplates)
      .set({ name: "an_office_specific_name" })
      .where(eq(schema.whatsappTemplates.organizationId, orgB));

    const b = await resolveApprovedTemplate(orgB, "DOCUMENT_REMINDER");
    expect(b.ok, "intent is the key, not a name the code holds").toBe(true);
    expect(b.ok && b.template.name).toBe("an_office_specific_name");
  });
});

describe("a send context is all-or-nothing from one organization", () => {
  it("B gets its own credentials AND its own template together", async () => {
    const ctx = await resolveTemplateSendContext(orgB, "DOCUMENT_REMINDER");

    expect(ctx.ok).toBe(true);
    expect(ctx.ok && ctx.config.phoneNumberId).toBe("phone-B");
    expect(ctx.ok && ctx.config.accessToken).toBe("token-B");
    expect(ctx.ok && ctx.template.wabaId).toBe("waba-B");
  });

  it("A — valid credentials, no template — gets no context at all", async () => {
    const ctx = await resolveTemplateSendContext(orgA, "DOCUMENT_REMINDER");

    expect(ctx.ok, "valid credentials must not license another tenant's template").toBe(false);
    expect(!ctx.ok && ctx.problem).toBe("no_template");
  });

  it("a template approved on a WABA the organization no longer uses is refused", async () => {
    // The row keeps the WABA it was approved on, so a reconnected office can
    // hold a template belonging to its previous account. Sending it with the
    // current account's token would be a cross-account send.
    await db
      .update(schema.organizations)
      .set({ whatsappBusinessAccountId: "waba-B-reconnected" })
      .where(eq(schema.organizations.id, orgB));

    const ctx = await resolveTemplateSendContext(orgB, "DOCUMENT_REMINDER");
    expect(ctx.ok).toBe(false);
    expect(!ctx.ok && ctx.reason).toContain("WABA");
  });
});
