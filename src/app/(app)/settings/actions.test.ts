import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { Session } from "@/lib/auth/session";

// Proves updateBusinessHours' validate-then-reject discipline (Settings UX
// polish): every one of the four real rules (at least one work day, start
// < end, reminder interval in 1-24, a supported timezone) rejects outright
// with zero persistence — never a partial write, never a silent clamp.
// Also proves inactivityTimeoutMinutes/collectionDayOfMonth (no longer
// edited by this form) survive a save completely untouched.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

let currentSession: Session;
vi.mock("@/lib/auth/session", () => ({
  requireSession: vi.fn(async () => currentSession),
}));

// refresh() throws outside a real Server Action invocation ("refresh can
// only be called from within a Server Action") — Vitest calls the action
// function directly, not through Next's request pipeline, so this is a
// pure test-harness shim, not a change to what updateBusinessHours does.
vi.mock("next/cache", () => ({
  refresh: vi.fn(),
}));

const { updateBusinessHours } = await import("./actions");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedOrg() {
  const [org] = await db
    .insert(schema.organizations)
    .values({
      name: "Org",
      businessHoursStart: "09:00",
      businessHoursEnd: "18:00",
      businessDays: "0,1,2,3,4",
      timezone: "Asia/Jerusalem",
      reminderIntervalHours: 5,
      inactivityTimeoutMinutes: 15,
      collectionDayOfMonth: 1,
    })
    .returning();
  const [user] = await db
    .insert(schema.users)
    .values({ organizationId: org.id, email: `${crypto.randomUUID()}@test.com`, passwordHash: "x", fullName: "Tester" })
    .returning();
  currentSession = {
    sessionId: "s1",
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    organizationId: org.id,
    organizationName: org.name,
  } as Session;
  return org.id;
}

function formData(entries: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(entries)) fd.append(key, value);
  return fd;
}

const VALID = {
  "day-0": "on",
  "day-1": "on",
  "day-2": "on",
  "day-3": "on",
  "day-4": "on",
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  timezone: "Asia/Jerusalem",
  reminderIntervalHours: "5",
};

describe("updateBusinessHours — validate-then-reject, never partial persistence", () => {
  it("rejects with no work day selected, and writes nothing", async () => {
    const orgId = await seedOrg();
    const fd = formData({ ...VALID, "day-0": "", "day-1": "", "day-2": "", "day-3": "", "day-4": "" });

    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeTruthy();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.businessDays).toBe("0,1,2,3,4"); // untouched — the seeded default
  });

  it("rejects when end time is not after start time, and writes nothing", async () => {
    const orgId = await seedOrg();
    const fd = formData({ ...VALID, businessHoursStart: "18:00", businessHoursEnd: "09:00" });

    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeTruthy();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.businessHoursStart).toBe("09:00");
    expect(after.businessHoursEnd).toBe("18:00");
  });

  it("rejects equal start/end time too (not just start > end)", async () => {
    await seedOrg();
    const fd = formData({ ...VALID, businessHoursStart: "09:00", businessHoursEnd: "09:00" });
    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeTruthy();
  });

  it("rejects a reminder interval outside 1-24, and writes nothing (no silent clamp)", async () => {
    const orgId = await seedOrg();
    const fd = formData({ ...VALID, reminderIntervalHours: "48" });

    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeTruthy();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.reminderIntervalHours).toBe(5); // untouched, not clamped to 24
  });

  it("rejects an unsupported timezone, and writes nothing", async () => {
    const orgId = await seedOrg();
    const fd = formData({ ...VALID, timezone: "America/New_York" });

    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeTruthy();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.timezone).toBe("Asia/Jerusalem");
  });

  it("saves successfully with valid input, and leaves inactivityTimeoutMinutes/collectionDayOfMonth completely untouched", async () => {
    const orgId = await seedOrg();
    const fd = formData({
      "day-0": "on",
      "day-5": "on",
      businessHoursStart: "08:30",
      businessHoursEnd: "17:00",
      timezone: "UTC",
      reminderIntervalHours: "3",
    });

    const result = await updateBusinessHours({}, fd);
    expect(result.error).toBeUndefined();

    const [after] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(after.businessDays).toBe("0,5");
    expect(after.businessHoursStart).toBe("08:30");
    expect(after.businessHoursEnd).toBe("17:00");
    expect(after.timezone).toBe("UTC");
    expect(after.reminderIntervalHours).toBe(3);
    // This form no longer edits these two — a real, independent engine
    // consumer (scheduler.ts / recurringScheduler.ts) still reads them,
    // so a save here must never silently reset them to their column
    // defaults.
    expect(after.inactivityTimeoutMinutes).toBe(15);
    expect(after.collectionDayOfMonth).toBe(1);
  });

  it("reload-after-save reads back exactly what was persisted (change -> save -> reload -> same value)", async () => {
    const orgId = await seedOrg();
    const fd = formData({ ...VALID, reminderIntervalHours: "12" });
    await updateBusinessHours({}, fd);

    const [reloaded] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    expect(reloaded.reminderIntervalHours).toBe(12);
    expect(reloaded.businessDays).toBe("0,1,2,3,4");
    expect(reloaded.timezone).toBe("Asia/Jerusalem");
  });
});
