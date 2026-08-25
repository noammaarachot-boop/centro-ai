import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// The forgot-password flow is the only route back into an account for a
// locked-out user. These cover the property that matters most — it must
// never claim to have sent an email that was not sent — without giving up
// the anti-enumeration property that made the old code swallow failures.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

vi.mock("next/headers", () => ({
  headers: async () => new Map([["host", "app.example.com"]]),
}));

const sendPasswordResetEmail = vi.fn();
vi.mock("@/lib/email/passwordReset", () => ({
  sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmail(...args),
}));

const isEmailConfigured = vi.fn(() => true);
vi.mock("@/lib/email/mailer", () => ({
  isEmailConfigured: () => isEmailConfigured(),
}));

const { requestPasswordReset } = await import("./actions");

let orgId: string;
let userEmail: string;

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
  await db.execute(sql`select 1`);
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  orgId = org.id;
}, 60_000);

beforeEach(async () => {
  vi.clearAllMocks();
  isEmailConfigured.mockReturnValue(true);
  sendPasswordResetEmail.mockResolvedValue(undefined);
  // A fresh address each time so the per-email rate limiter (5 per 15 min,
  // process-local) never bleeds between tests.
  userEmail = `user-${crypto.randomUUID()}@example.com`;
  await db.insert(schema.users).values({
    organizationId: orgId,
    email: userEmail,
    passwordHash: "x",
    fullName: "Tester",
  });
});

function form(email: string) {
  const fd = new FormData();
  fd.set("email", email);
  return fd;
}

describe("requestPasswordReset — happy path", () => {
  it("sends the email and reports success", async () => {
    const state = await requestPasswordReset({}, form(userEmail));

    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ submitted: true });
  });

  it("puts a real token in the database and the reset URL in the email", async () => {
    await requestPasswordReset({}, form(userEmail));

    const [user] = await db.select().from(schema.users).where(eq(schema.users.email, userEmail));
    const tokens = await db
      .select()
      .from(schema.passwordResetTokens)
      .where(eq(schema.passwordResetTokens.userId, user.id));
    expect(tokens).toHaveLength(1);

    const [, resetUrl] = sendPasswordResetEmail.mock.calls[0];
    expect(resetUrl).toContain(tokens[0].token);
  });
});

describe("requestPasswordReset — never claims an email was sent when it wasn't", () => {
  // The regression this whole change exists to prevent.
  it("reports an error, NOT success, when the send fails", async () => {
    sendPasswordResetEmail.mockRejectedValue(new Error("SMTP timeout"));

    const state = await requestPasswordReset({}, form(userEmail));

    expect(state.submitted).toBeUndefined();
    expect(state.error).toMatch(/נכשלה/);
  });

  it("records a critical audit event when the send fails", async () => {
    sendPasswordResetEmail.mockRejectedValue(new Error("SMTP timeout"));

    await requestPasswordReset({}, form(userEmail));

    const events = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.eventType, "employee.password_reset_email_failed"));
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.metadata).toMatchObject({ severity: "critical" });
  });

  it("reports an error when email is not configured at all", async () => {
    isEmailConfigured.mockReturnValue(false);

    const state = await requestPasswordReset({}, form(userEmail));

    expect(state.submitted).toBeUndefined();
    expect(state.error).toMatch(/נכשלה/);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("requestPasswordReset — user enumeration", () => {
  it("answers an unknown address exactly as it answers a real one", async () => {
    const real = await requestPasswordReset({}, form(userEmail));
    const unknown = await requestPasswordReset({}, form(`nobody-${crypto.randomUUID()}@example.com`));

    expect(unknown).toEqual(real);
    expect(unknown).toEqual({ submitted: true });
  });

  // The reason isEmailConfigured() is checked BEFORE the account lookup: if
  // it were checked after, an unconfigured deployment would answer "success"
  // for addresses with no account and "error" for real ones — turning a
  // misconfiguration into a way to test whether someone has an account.
  it("answers identically for known and unknown addresses when email is unconfigured", async () => {
    isEmailConfigured.mockReturnValue(false);

    const real = await requestPasswordReset({}, form(userEmail));
    const unknown = await requestPasswordReset({}, form(`nobody-${crypto.randomUUID()}@example.com`));

    expect(unknown).toEqual(real);
    expect(real.submitted).toBeUndefined();
  });

  it("creates no reset token for an unknown address", async () => {
    const before = await db.select().from(schema.passwordResetTokens);
    await requestPasswordReset({}, form(`nobody-${crypto.randomUUID()}@example.com`));
    const after = await db.select().from(schema.passwordResetTokens);

    expect(after).toHaveLength(before.length);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });
});

describe("requestPasswordReset — input handling", () => {
  it("rejects a malformed address without touching the database", async () => {
    const state = await requestPasswordReset({}, form("not-an-email"));

    expect(state.error).toMatch(/תקינה/);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("rate-limits repeated requests for the same address", async () => {
    let last = await requestPasswordReset({}, form(userEmail));
    for (let i = 0; i < 6 && !last.error; i += 1) {
      last = await requestPasswordReset({}, form(userEmail));
    }
    expect(last.error).toMatch(/יותר מדי/);
  });
});
