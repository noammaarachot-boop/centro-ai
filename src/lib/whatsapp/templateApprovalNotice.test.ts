import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { seedApprovedWhatsAppTemplates } from "@/test/whatsappFixtures";

// The one-time "your templates are approved" email.
//
// What matters here is not that an email can be sent, but that it is sent
// EXACTLY once, that a failed send can be retried, and that a mail problem
// never turns a successful Meta sync into a failure.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "shared-system-token" }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const sendTransactionalEmail = vi.fn();
vi.mock("@/lib/email/mailer", () => ({
  sendTransactionalEmail: (...args: unknown[]) => sendTransactionalEmail(...args),
  EmailNotConfiguredError: class extends Error {},
}));

const fetchMock = vi.fn();

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  sendTransactionalEmail.mockReset();
  sendTransactionalEmail.mockResolvedValue(undefined);
  process.env.WHATSAPP_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
});

const { syncTemplatesAndNotify, notifyTemplatesApproved, pollTemplateApprovalIfDue } = await import(
  "./templateApprovalNotice"
);
const { MANAGED_TEMPLATES } = await import("./templateManagement");
const { encryptWhatsAppToken } = await import("./tokenCipher");

async function seedOrg(options?: {
  withOwnToken?: boolean;
  email?: string;
  connected?: boolean;
  alreadyNotified?: boolean;
}) {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      whatsappBusinessAccountId: `waba-${crypto.randomUUID()}`,
      whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
      whatsappConnectedAt: options?.connected === false ? null : new Date(),
      whatsappAccessTokenEnc:
        options?.withOwnToken === false ? null : encryptWhatsAppToken("org-own-token"),
      templatesApprovedEmailSentAt: options?.alreadyNotified ? new Date() : null,
    })
    .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
  await db.insert(schema.users).values({
    organizationId: org.id,
    email: options?.email ?? `${crypto.randomUUID()}@office.example`,
    passwordHash: "x",
  });
  return org;
}

/** Meta reporting every managed template with the given status. */
function mockMetaStatuses(status: string) {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({
      data: MANAGED_TEMPLATES.map((template, index) => ({
        id: `meta-tpl-${index}`,
        name: template.name,
        language: template.language,
        status,
        category: "UTILITY",
        rejected_reason: "NONE",
      })),
    }),
  });
}

async function orgRow(id: string) {
  const [row] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, id));
  return row;
}

describe("syncTemplatesAndNotify — eligibility is decided by Meta, not local state", () => {
  it("sends the email once every managed template is APPROVED", async () => {
    const org = await seedOrg({ email: "owner@office.example" });
    mockMetaStatuses("APPROVED");

    const result = await syncTemplatesAndNotify(org.id);

    expect(result.allApproved).toBe(true);
    expect(result.emailSent).toBe(true);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    const [payload] = sendTransactionalEmail.mock.calls[0];
    expect(payload.to).toBe("owner@office.example");
    expect(payload.subject).toContain("מזל טוב");
    // The call to action points at the real wizard route.
    expect(payload.html).toContain("/collections/new");
    expect(payload.text).toContain("/collections/new");
    expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeInstanceOf(Date);
  });

  for (const status of ["PENDING", "REJECTED", "PAUSED"]) {
    it(`sends NOTHING while a template is ${status}`, async () => {
      const org = await seedOrg();
      mockMetaStatuses(status);

      const result = await syncTemplatesAndNotify(org.id);

      expect(result.allApproved).toBe(false);
      expect(result.emailSent).toBe(false);
      expect(sendTransactionalEmail).not.toHaveBeenCalled();
      expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeNull();
    });
  }

  it("sends nothing when a required template is missing from the WABA entirely", async () => {
    const org = await seedOrg();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-0",
            name: MANAGED_TEMPLATES[0].name,
            language: MANAGED_TEMPLATES[0].language,
            status: "APPROVED",
            category: "UTILITY",
            rejected_reason: "NONE",
          },
        ],
      }),
    });

    const result = await syncTemplatesAndNotify(org.id);

    expect(result.allApproved).toBe(false);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });

  it("works for an Embedded Signup organization (no own token) using the shared system token", async () => {
    const org = await seedOrg({ withOwnToken: false });
    mockMetaStatuses("APPROVED");

    const result = await syncTemplatesAndNotify(org.id);

    expect(result.emailSent).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer shared-system-token");
  });

  it("uses the organization's OWN token when it has one", async () => {
    const org = await seedOrg();
    mockMetaStatuses("APPROVED");

    await syncTemplatesAndNotify(org.id);

    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer org-own-token");
  });

  it("adopts templates that exist on the WABA but were never recorded locally", async () => {
    const org = await seedOrg();
    mockMetaStatuses("APPROVED");

    await syncTemplatesAndNotify(org.id);

    const rows = await db
      .select()
      .from(schema.whatsappTemplates)
      .where(eq(schema.whatsappTemplates.organizationId, org.id));
    expect(rows).toHaveLength(MANAGED_TEMPLATES.length);
    expect(rows.every((row) => row.status === "APPROVED")).toBe(true);
  });
});

describe("no duplicates", () => {
  it("a second sync after approval does not send again", async () => {
    const org = await seedOrg();
    mockMetaStatuses("APPROVED");

    const first = await syncTemplatesAndNotify(org.id);
    const second = await syncTemplatesAndNotify(org.id);
    const third = await syncTemplatesAndNotify(org.id);

    expect(first.emailSent).toBe(true);
    expect(second.emailSent).toBe(false);
    expect(third.emailSent).toBe(false);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    // A repeat is not an error — the sync itself still succeeded.
    expect(second.emailError).toBeNull();
    expect(second.allApproved).toBe(true);
  });

  it("CONCURRENCY: two callers racing on the same organization produce exactly one email", async () => {
    const org = await seedOrg();

    // Both enter notifyTemplatesApproved at the same time; only the caller
    // whose conditional UPDATE matches a row may send.
    const [a, b] = await Promise.all([
      notifyTemplatesApproved(org.id),
      notifyTemplatesApproved(org.id),
    ]);

    expect([a.emailSent, b.emailSent].filter(Boolean)).toHaveLength(1);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
  });

  it("an organization already marked as notified is never emailed again", async () => {
    const org = await seedOrg({ alreadyNotified: true });
    mockMetaStatuses("APPROVED");

    const result = await syncTemplatesAndNotify(org.id);

    expect(result.emailSent).toBe(false);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
  });
});

describe("failed send is retryable and never falsely recorded", () => {
  it("releases the claim when the mail service fails, so the organization is NOT left marked as notified", async () => {
    const org = await seedOrg();
    sendTransactionalEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));
    mockMetaStatuses("APPROVED");

    const result = await syncTemplatesAndNotify(org.id);

    expect(result.emailSent).toBe(false);
    expect(result.emailError).toContain("SMTP unavailable");
    // The critical assertion: not marked sent.
    expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeNull();
  });

  it("a later retry succeeds and then marks it sent", async () => {
    const org = await seedOrg();
    mockMetaStatuses("APPROVED");
    sendTransactionalEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));

    const failed = await syncTemplatesAndNotify(org.id);
    expect(failed.emailSent).toBe(false);

    const retried = await syncTemplatesAndNotify(org.id);

    expect(retried.emailSent).toBe(true);
    expect(sendTransactionalEmail).toHaveBeenCalledTimes(2);
    expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeInstanceOf(Date);
  });

  it("FAULT ISOLATION: a mail failure never turns a successful Meta sync into a failed one", async () => {
    const org = await seedOrg();
    mockMetaStatuses("APPROVED");
    sendTransactionalEmail.mockRejectedValueOnce(new Error("SMTP unavailable"));

    // Does not throw, and still reports the sync's own success.
    const result = await syncTemplatesAndNotify(org.id);

    expect(result.synced).toBe(MANAGED_TEMPLATES.length);
    expect(result.allApproved).toBe(true);
    expect(result.emailError).toBeTruthy();
  });

  it("does not claim or send when the organization has no email address", async () => {
    const [org] = await db
      .insert(schema.organizations)
      .values({
        name: "No user org",
        whatsappBusinessAccountId: `waba-${crypto.randomUUID()}`,
        whatsappConnectedAt: new Date(),
        whatsappAccessTokenEnc: encryptWhatsAppToken("org-own-token"),
      })
      .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);

    const result = await notifyTemplatesApproved(org.id);

    expect(result.emailSent).toBe(false);
    expect(sendTransactionalEmail).not.toHaveBeenCalled();
    expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeNull();
  });
});

describe("pollTemplateApprovalIfDue — the cron pass stays cheap and self-terminating", () => {
  it("polls a connected, not-yet-notified organization exactly once, then throttles", async () => {
    const org = await seedOrg();
    mockMetaStatuses("PENDING");

    expect(await pollTemplateApprovalIfDue(org.id)).toBe(true);
    // Immediately due again? No — the throttle stamp was just set.
    expect(await pollTemplateApprovalIfDue(org.id)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("KEEPS polling an already-notified organization — the email is one-shot, the status is not", async () => {
    // This used to assert the opposite. templatesApprovedEmailSentAt gated
    // the poll itself, so status synchronisation stopped permanently the
    // moment the approval email went out — after which Meta pausing,
    // disabling or deleting a template was invisible to Centro forever, and
    // the send path kept believing a template was approved. The email keeps
    // its own one-shot claim inside notifyTemplatesApproved.
    const org = await seedOrg({ alreadyNotified: true });

    expect(await pollTemplateApprovalIfDue(org.id)).toBe(true);
    expect(fetchMock, "Meta must still be asked for the current status").toHaveBeenCalled();
    expect(sendTransactionalEmail, "but the owner is never emailed twice").not.toHaveBeenCalled();
  });

  it("never polls an organization with no WhatsApp connection", async () => {
    const org = await seedOrg({ connected: false });

    expect(await pollTemplateApprovalIfDue(org.id)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never polls a suspended organization", async () => {
    const org = await seedOrg();
    await db
      .update(schema.organizations)
      .set({ suspendedAt: new Date() })
      .where(eq(schema.organizations.id, org.id));

    expect(await pollTemplateApprovalIfDue(org.id)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a Meta failure inside the poll never propagates out and breaks the tick", async () => {
    const org = await seedOrg();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "meta down" });

    await expect(pollTemplateApprovalIfDue(org.id)).resolves.toBe(true);
  });

  it("CONCURRENCY: two ticks racing on the same organization poll Meta only once", async () => {
    const org = await seedOrg();
    mockMetaStatuses("PENDING");

    const [a, b] = await Promise.all([
      pollTemplateApprovalIfDue(org.id),
      pollTemplateApprovalIfDue(org.id),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("sends the email from the cron path too, with no manual refresh involved", async () => {
    const org = await seedOrg({ email: "cron-owner@office.example" });
    mockMetaStatuses("APPROVED");

    expect(await pollTemplateApprovalIfDue(org.id)).toBe(true);

    expect(sendTransactionalEmail).toHaveBeenCalledTimes(1);
    expect(sendTransactionalEmail.mock.calls[0][0].to).toBe("cron-owner@office.example");
    expect((await orgRow(org.id)).templatesApprovedEmailSentAt).toBeInstanceOf(Date);
  });
});
