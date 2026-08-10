import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";

// Phase 4.6 remediation — createExtensionFinishedCheckIfDue
// (src/lib/requestExtension.ts) reads open confirmations, then inserts if
// none match: a read-then-insert race. The partial unique index on
// pendingConfirmations (src/db/schema.ts) is the real backstop; the fast
// list-check is only ever the common-case shortcut. vi.mock calls are
// hoisted above every import in this file regardless of where they're
// written — declared at true top level (not nested inside a describe
// block), matching this repo's established pattern.
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
const sendInteractiveButtonsMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendInteractiveButtonsMessage: (...args: unknown[]) => sendInteractiveButtonsMessage(...args),
    sendTemplateMessage: vi.fn(),
  };
});

// Only listOpenConfirmationsForCollectionRequest is overridden — everything
// else (createPendingConfirmation, resolveConfirmationFromReply, ...) stays
// real. Defaulted in beforeEach to the same query the real function runs,
// so tests 1/2 below see genuine fast-path behavior; only the dedicated
// race test overrides it to simulate the read missing a concurrent insert.
const listOpenConfirmationsForCollectionRequestMock = vi.fn();
vi.mock("@/lib/pendingConfirmations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/pendingConfirmations")>("@/lib/pendingConfirmations");
  return {
    ...actual,
    listOpenConfirmationsForCollectionRequest: (...args: [string]) =>
      listOpenConfirmationsForCollectionRequestMock(...args),
  };
});

const { createExtensionFinishedCheckIfDue } = await import("./requestExtension");

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
  sendInteractiveButtonsMessage.mockReset();
  sendInteractiveButtonsMessage.mockResolvedValue({ messageId: "wamid.out" });
  listOpenConfirmationsForCollectionRequestMock.mockReset();
  listOpenConfirmationsForCollectionRequestMock.mockImplementation(async (collectionRequestId: string) =>
    db
      .select()
      .from(schema.pendingConfirmations)
      .where(
        and(
          eq(schema.pendingConfirmations.collectionRequestId, collectionRequestId),
          eq(schema.pendingConfirmations.status, "pending")
        )
      )
  );
});

async function seedActiveExtension() {
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
  const [client] = await db.insert(schema.clients).values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" }).returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status: "completed", extensionActive: true })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id };
}

async function countFinishedChecks(requestId: string) {
  const rows = await db
    .select()
    .from(schema.pendingConfirmations)
    .where(
      and(
        eq(schema.pendingConfirmations.collectionRequestId, requestId),
        eq(schema.pendingConfirmations.kind, "extension_finished_check")
      )
    );
  return rows.length;
}

describe("createExtensionFinishedCheckIfDue", () => {
  it("creates the finished-check confirmation when none is open yet", async () => {
    const { orgId, clientId, requestId } = await seedActiveExtension();

    const created = await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });

    expect(created).toBe(true);
    expect(await countFinishedChecks(requestId)).toBe(1);
  });

  it("is a no-op (fast path) when a finished-check confirmation is already open — never asks twice", async () => {
    const { orgId, clientId, requestId } = await seedActiveExtension();

    const first = await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    expect(first).toBe(true);

    const second = await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    expect(second).toBe(false);
    expect(await countFinishedChecks(requestId)).toBe(1);
  });

  it("Phase 4.6: the partial unique index is the real backstop — even when the fast-path read misses a concurrent row (simulating a genuine race), the duplicate insert still fails and is caught as a no-op", async () => {
    const { orgId, clientId, requestId } = await seedActiveExtension();

    // Winning side of the race already committed its row...
    const first = await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });
    expect(first).toBe(true);
    expect(await countFinishedChecks(requestId)).toBe(1);

    // ...but this call's own fast-path read is forced to report "nothing
    // open" anyway, exactly as it could if it ran concurrently just before
    // the winner's insert committed. Only the database constraint is left
    // to prevent a second row.
    listOpenConfirmationsForCollectionRequestMock.mockResolvedValueOnce([]);

    const second = await createExtensionFinishedCheckIfDue({ organizationId: orgId, clientId, collectionRequestId: requestId });

    expect(second).toBe(false);
    expect(await countFinishedChecks(requestId)).toBe(1); // still exactly one — never duplicated
  });
});
