import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

// Proves submitSupportRequest: validate-then-reject with zero persistence
// on rejection; the request is durably saved BEFORE email is attempted
// (so a delivery failure never loses it) but success is only ever
// reported to the user after email genuinely succeeds; every identity
// field attached (user id/name/email, organization id/name) comes from
// the server-side session, never from attacker-controlled formData; the
// ticket number is a real, server-generated, increasing sequence; and
// per-user rate limiting kicks in after too many submissions.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

const sendSupportRequestEmail = vi.fn();
vi.mock("@/lib/email/supportRequest", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email/supportRequest")>(
    "@/lib/email/supportRequest"
  );
  return {
    ...actual,
    sendSupportRequestEmail: (...args: unknown[]) => sendSupportRequestEmail(...args),
  };
});

const { submitSupportRequest } = await import("./actions");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendSupportRequestEmail.mockReset().mockResolvedValue(undefined);
});

async function seedSession(overrides: Partial<{ fullName: string | null }> = {}) {
  const [org] = await db.insert(schema.organizations).values({ name: "עסק לדוגמה" }).returning();
  const [user] = await db
    .insert(schema.users)
    .values({
      organizationId: org.id,
      email: `${crypto.randomUUID()}@test.com`,
      passwordHash: "x",
      fullName: overrides.fullName ?? "ישראל ישראלי",
    })
    .returning();
  currentSession = {
    sessionId: "s1",
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    organizationId: org.id,
    organizationName: org.name,
    organizationSuspendedAt: null,
    organizationQaModeEnabledAt: null,
  } as Session;
  return { orgId: org.id, userId: user.id };
}

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

const VALID = {
  category: "not_working",
  subject: "המערכת לא שולחת תזכורות",
  message: "ניסיתי להפעיל תזכורת אתמול ולא קרה כלום.",
  currentPage: "/dashboard",
  timezone: "Asia/Jerusalem",
};

describe("submitSupportRequest", () => {
  it("rejects a missing/invalid category, and writes nothing", async () => {
    await seedSession();
    const fd = formData({ ...VALID, category: "not-a-real-category" });

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeTruthy();
    expect(result.success).toBeUndefined();

    const rows = await db.select().from(schema.supportRequests);
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty subject, and writes nothing", async () => {
    await seedSession();
    const fd = formData({ ...VALID, subject: "   " });

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeTruthy();

    const rows = await db.select().from(schema.supportRequests);
    expect(rows).toHaveLength(0);
  });

  it("rejects a subject over the max length, and writes nothing", async () => {
    await seedSession();
    const fd = formData({ ...VALID, subject: "א".repeat(201) });

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeTruthy();

    const rows = await db.select().from(schema.supportRequests);
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty message, and writes nothing", async () => {
    await seedSession();
    const fd = formData({ ...VALID, message: "" });

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeTruthy();

    const rows = await db.select().from(schema.supportRequests);
    expect(rows).toHaveLength(0);
  });

  it("rejects a message over the max length, and writes nothing", async () => {
    await seedSession();
    const fd = formData({ ...VALID, message: "א".repeat(4001) });

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeTruthy();

    const rows = await db.select().from(schema.supportRequests);
    expect(rows).toHaveLength(0);
  });

  it("on success: persists the row, sends the email, returns a real server-generated ticket number, and records an audit event", async () => {
    const { orgId, userId } = await seedSession();
    const fd = formData(VALID);

    const result = await submitSupportRequest({}, fd);
    expect(result.error).toBeUndefined();
    expect(result.success).toBeDefined();
    expect(Number.isInteger(result.success!.ticketNumber)).toBe(true);

    const [row] = await db
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.organizationId, orgId));
    expect(row.ticketNumber).toBe(result.success!.ticketNumber);
    expect(row.organizationId).toBe(orgId);
    expect(row.userId).toBe(userId);
    expect(row.userName).toBe("ישראל ישראלי");
    expect(row.deliveryStatus).toBe("sent");
    expect(row.emailSentAt).not.toBeNull();
    expect(sendSupportRequestEmail).toHaveBeenCalledTimes(1);

    const [auditRow] = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(eq(schema.auditLogs.eventType, "support.request_created"), eq(schema.auditLogs.organizationId, orgId))
      );
    expect(auditRow).toBeDefined();
    expect(auditRow.organizationId).toBe(orgId);
  });

  it("ignores any organizationId/userId/userEmail spoofed via form fields — identity always comes from the session", async () => {
    const { orgId, userId } = await seedSession();
    const fd = formData({
      ...VALID,
      organizationId: "11111111-1111-1111-1111-111111111111",
      userId: "22222222-2222-2222-2222-222222222222",
      userEmail: "attacker@evil.com",
    });

    const result = await submitSupportRequest({}, fd);
    expect(result.success).toBeDefined();

    const [row] = await db
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.organizationId, orgId));
    expect(row.organizationId).toBe(orgId);
    expect(row.userId).toBe(userId);
    expect(row.userEmail).not.toBe("attacker@evil.com");
    expect(row.userEmail).toBe(currentSession.email);
  });

  it("two successful submissions get different, increasing ticket numbers", async () => {
    await seedSession();
    const first = await submitSupportRequest({}, formData(VALID));
    const second = await submitSupportRequest({}, formData(VALID));

    expect(second.success!.ticketNumber).toBeGreaterThan(first.success!.ticketNumber);
  });

  it("on email delivery failure: does NOT report success, but the request stays persisted (never lost)", async () => {
    const { orgId } = await seedSession();
    sendSupportRequestEmail.mockRejectedValue(new Error("SMTP timeout"));
    const fd = formData(VALID);

    const result = await submitSupportRequest({}, fd);
    expect(result.success).toBeUndefined();
    expect(result.error).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.organizationId, orgId));
    expect(row).toBeDefined();
    expect(row.organizationId).toBe(orgId);
    expect(row.deliveryStatus).toBe("failed");
    expect(row.emailError).toContain("SMTP timeout");
    expect(row.emailSentAt).toBeNull();

    const auditRows = await db
      .select()
      .from(schema.auditLogs)
      .where(
        and(eq(schema.auditLogs.eventType, "support.request_created"), eq(schema.auditLogs.organizationId, orgId))
      );
    expect(auditRows).toHaveLength(0);
  });

  it("rate-limits a user after too many submissions within the window", async () => {
    const { orgId } = await seedSession();
    for (let i = 0; i < 5; i += 1) {
      const result = await submitSupportRequest({}, formData(VALID));
      expect(result.success).toBeDefined();
    }
    const sixth = await submitSupportRequest({}, formData(VALID));
    expect(sixth.error).toBeTruthy();
    expect(sixth.success).toBeUndefined();

    const rows = await db
      .select()
      .from(schema.supportRequests)
      .where(eq(schema.supportRequests.organizationId, orgId));
    expect(rows).toHaveLength(5); // the 6th never even attempted to persist
  });
});
