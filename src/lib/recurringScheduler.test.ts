import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// vi.mock calls are hoisted above every import in this file regardless of
// where they're written — declared at true top level (not nested inside a
// describe block) since vitest only guarantees correct hoisting semantics
// there. The pure date-math describe blocks below never touch the DB/send
// layer at all, so mocking these globally for the whole file doesn't
// affect them.
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTemplateMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTemplateMessage: (...args: unknown[]) => sendTemplateMessage(...args),
    sendTextMessage: vi.fn(),
    sendInteractiveButtonsMessage: vi.fn(),
  };
});

import {
  advanceCollectionRunAt,
  computeInitialCollectionRunAt,
  formatAutoPeriodLabel,
  runRecurringCycleCreation,
} from "./recurringScheduler";

describe("computeInitialCollectionRunAt", () => {
  it("uses this month's anchor day when it hasn't passed yet", () => {
    const from = new Date(2026, 0, 5); // Jan 5, 2026
    const result = computeInitialCollectionRunAt(15, from);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(15);
  });

  it("rolls over to next month once the anchor day has already passed", () => {
    const from = new Date(2026, 0, 20); // Jan 20, 2026
    const result = computeInitialCollectionRunAt(15, from);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it("clamps an anchor day beyond a short month's length", () => {
    // From late January, anchor day 31 rolls to February, which only has 28
    // days in 2026 (not a leap year).
    const from = new Date(2026, 0, 31, 23, 59);
    const result = computeInitialCollectionRunAt(31, from);
    expect(result.getMonth()).toBe(1);
    expect(result.getDate()).toBe(28);
  });
});

describe("advanceCollectionRunAt", () => {
  it("advances from the previous scheduled date, not from now, avoiding drift", () => {
    const previous = new Date(2026, 0, 15); // Jan 15
    const result = advanceCollectionRunAt(previous, 15, 1);
    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(15);
  });

  it("supports a custom multi-month interval (e.g. quarterly)", () => {
    const previous = new Date(2026, 0, 10);
    const result = advanceCollectionRunAt(previous, 10, 3);
    expect(result.getMonth()).toBe(3); // April — three months after January
    expect(result.getDate()).toBe(10);
  });

  it("clamps into a shorter month when advancing past a 31-day anchor", () => {
    const previous = new Date(2026, 0, 31); // Jan 31
    const result = advanceCollectionRunAt(previous, 31, 1);
    expect(result.getMonth()).toBe(1); // February
    expect(result.getDate()).toBe(28); // 2026 is not a leap year
  });

  it("rolls over the year boundary correctly", () => {
    const previous = new Date(2026, 11, 5); // Dec 5, 2026
    const result = advanceCollectionRunAt(previous, 5, 1);
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
  });
});

describe("formatAutoPeriodLabel", () => {
  it("labels a monthly cycle with just the month and year", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 0, 15), 1)).toBe("ינואר 2026");
  });

  it("labels a quarterly cycle as a month range within the same year", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 2, 15), 3)).toBe("ינואר–מרץ 2026");
  });

  it("labels a range spanning a year boundary with both years", () => {
    expect(formatAutoPeriodLabel(new Date(2026, 1, 1), 6)).toBe("ספטמבר 2025–פברואר 2026");
  });
});

describe("runRecurringCycleCreation — Phase 4.4: atomic claim prevents double-creating a cycle for the same pairing", () => {
  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await migrate(db as never, { migrationsFolder: "./drizzle" });
  }, 60_000);

  beforeEach(() => {
    sendTemplateMessage.mockReset();
    sendTemplateMessage.mockResolvedValue({ messageId: "wamid.out" });
  });

  async function seedDueRecurringPairing() {
    const [org] = await db
      .insert(schema.organizations)
      .values({
        name: "Org",
        whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`,
        documentCollectionEnabled: true,
        collectionDayOfMonth: 1,
      })
      .returning();
    const [client] = await db.insert(schema.clients).values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" }).returning();
    const [service] = await db
      .insert(schema.services)
      .values({ organizationId: org.id, name: "שירות חוזר", collectionMode: "recurring", collectionFrequencyIntervalMonths: 1 })
      .returning();
    const [clientService] = await db
      .insert(schema.clientServices)
      .values({ clientId: client.id, serviceId: service.id, nextCollectionRunAt: new Date(Date.now() - 60_000) })
      .returning();
    return { orgId: org.id, clientServiceId: clientService.id };
  }

  it("creates exactly one collection request for a genuinely due pairing", async () => {
    const { orgId } = await seedDueRecurringPairing();

    const { created } = await runRecurringCycleCreation(orgId);

    expect(created).toBe(1);
    const requests = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.organizationId, orgId));
    expect(requests).toHaveLength(1);
  });

  it("a pairing whose nextCollectionRunAt was already advanced by another tick (simulating a lost race) is never double-claimed — no duplicate collection request", async () => {
    const { orgId, clientServiceId } = await seedDueRecurringPairing();

    // Simulate a concurrent tick that already won the claim and advanced
    // the schedule, exactly as createAndSendRecurringCycle's own atomic
    // claim would have done — this row is no longer actually due.
    await db.update(schema.clientServices).set({ nextCollectionRunAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }).where(eq(schema.clientServices.id, clientServiceId));

    const { created } = await runRecurringCycleCreation(orgId);

    expect(created).toBe(0);
    const requests = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.organizationId, orgId));
    expect(requests).toHaveLength(0);
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it("running the creation pass twice in a row for the same due pairing only ever creates one cycle — the second run's claim fails on the first run's own already-advanced schedule", async () => {
    const { orgId } = await seedDueRecurringPairing();

    const first = await runRecurringCycleCreation(orgId);
    expect(first.created).toBe(1);

    const second = await runRecurringCycleCreation(orgId);
    expect(second.created).toBe(0); // the pairing's nextCollectionRunAt is now a real month away — no longer due

    const requests = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.organizationId, orgId));
    expect(requests).toHaveLength(1);
  });
});
