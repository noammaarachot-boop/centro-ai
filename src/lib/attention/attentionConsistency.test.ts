import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { resolveDisplayStatus } from "@/lib/requestDisplayStatus";
import { HUMAN_REVIEW_WINDOW_MS } from "@/lib/attention/policy";

/**
 * One request, one meaning, on every screen.
 *
 * The reported bug: a request whose card said "דורש טיפול" appeared in the
 * dashboard's own table as "בתהליך", at the same moment. Both were reading
 * real data. They were reading DIFFERENT data — the card measured the
 * client's silence itself, while the dashboard only knew about escalations
 * and review items, and the scheduler that creates escalations had been dead
 * for six days.
 *
 * These tests pin the property that makes that impossible: every surface
 * derives "does this need a human" from getItemsNeedingReview, so a screen
 * cannot hold a private opinion.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { getItemsNeedingReview, getRequestIdsNeedingAttention } = await import("@/lib/data/dashboardReadModel");
const { getOneTimeDashboardView } = await import("@/lib/data/oneTimeDashboardView");
const { escalateToHumanReview, clearEscalation } = await import("@/lib/collectionRequestStateMachine");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgId: string;
let otherOrgId: string;
let clientId: string;
let serviceId: string;

beforeEach(async () => {
  await db.delete(schema.attentionDismissals);
  await db.delete(schema.messages);
  await db.delete(schema.documents);
  await db.delete(schema.collectionRequestRequirements);
  await db.delete(schema.conversations);
  await db.delete(schema.collectionRequests);
  await db.delete(schema.clients);
  await db.delete(schema.services);
  await db.delete(schema.organizations);

  const [org] = await db.insert(schema.organizations).values({ name: "משרד" }).returning();
  const [other] = await db.insert(schema.organizations).values({ name: "משרד אחר" }).returning();
  orgId = org.id;
  otherOrgId = other.id;
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: orgId, name: "אורי", phone: "+972500000111" })
    .returning();
  clientId = client.id;
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "שירות" }).returning();
  serviceId = service.id;
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A request with one still-missing document, opened `ageDays` ago. */
async function seedRequest(options: {
  ageDays: number;
  status?: (typeof schema.collectionRequests.$inferInsert)["status"];
  withRequirement?: boolean;
  organizationId?: string;
  conversationStatus?: (typeof schema.conversations.$inferInsert)["status"];
}) {
  const org = options.organizationId ?? orgId;
  const [ownClient] =
    org === orgId
      ? [{ id: clientId }]
      : await db
          .insert(schema.clients)
          .values({ organizationId: org, name: "לקוח", phone: `+97250${Date.now() % 10000000}` })
          .returning();
  const [ownService] =
    org === orgId
      ? [{ id: serviceId }]
      : await db.insert(schema.services).values({ organizationId: org, name: "s" }).returning();

  const [request] = await db
    .insert(schema.collectionRequests)
    .values({
      organizationId: org,
      clientId: ownClient.id,
      serviceId: ownService.id,
      periodLabel: "p",
      status: options.status ?? "waiting_for_client",
      createdAt: new Date(Date.now() - options.ageDays * DAY_MS),
    })
    .returning();

  if (options.withRequirement !== false) {
    await db.insert(schema.collectionRequestRequirements).values({
      collectionRequestId: request.id,
      name: "תעודת זהות",
      requiredCount: 1,
    });
  }

  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org,
      clientId: ownClient.id,
      collectionRequestId: request.id,
      status: options.conversationStatus ?? "waiting_for_client",
    })
    .returning();

  return { requestId: request.id, conversationId: conversation.id, clientId: ownClient.id };
}

/** What the dashboard table and the request card each show for one request. */
async function displayedOn(requestId: string, status: (typeof schema.collectionRequests.$inferInsert)["status"] = "waiting_for_client") {
  const dashboard = await getOneTimeDashboardView(orgId);
  const row = dashboard.inProgress.find((r) => r.collectionRequestId === requestId);

  // The card asks the same question the same way — see the request page,
  // which passes myReviewReasons.length > 0.
  const items = await getItemsNeedingReview(orgId);
  const cardHasAttention = (items.find((i) => i.collectionRequestId === requestId)?.reasons.length ?? 0) > 0;

  return {
    dashboard: row ? resolveDisplayStatus({ status: row.status, hasOpenAttention: row.hasOpenAttention }).label : null,
    card: resolveDisplayStatus({ status, hasOpenAttention: cardHasAttention }).label,
    needsReviewCount: dashboard.kpis.needsReviewCount,
    inNeedsAttentionList: dashboard.needsAttention.some((r) => r.collectionRequestId === requestId),
  };
}

describe("the same request reads the same everywhere", () => {
  it("9 — an overdue request is 'דורש טיפול' on BOTH the card and the dashboard", async () => {
    // The exact reported case: five days open, document still missing, and
    // no escalation row because the scheduler never ran.
    const { requestId } = await seedRequest({ ageDays: 5 });

    const shown = await displayedOn(requestId);

    expect(shown.card).toBe("דורש טיפול");
    expect(shown.dashboard, "this said 'בתהליך' before — the whole bug").toBe("דורש טיפול");
  });

  it("1 — active with nothing pending is 'בתהליך' on both", async () => {
    const { requestId } = await seedRequest({ ageDays: 0, status: "active", conversationStatus: "open" });

    const shown = await displayedOn(requestId, "active");

    expect(shown.card).toBe("בתהליך");
    expect(shown.dashboard).toBe("בתהליך");
  });

  it("2 — waiting on the client with nothing pending is 'ממתין ללקוח' on both", async () => {
    const { requestId } = await seedRequest({ ageDays: 0 });

    const shown = await displayedOn(requestId);

    expect(shown.card).toBe("ממתין ללקוח");
    expect(shown.dashboard).toBe("ממתין ללקוח");
  });

  it("3 — an escalation reads as 'דורש טיפול' without changing where the request is", async () => {
    const { requestId } = await seedRequest({ ageDays: 0 });
    await escalateToHumanReview(orgId, requestId, "לא ענה", "system");

    const [row] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, requestId));
    expect(row.status, "the lifecycle survives the escalation").toBe("waiting_for_client");

    const shown = await displayedOn(requestId);
    expect(shown.card).toBe("דורש טיפול");
    expect(shown.dashboard).toBe("דורש טיפול");
  });

  it("4+5 — a finished request is finished on both, whatever else is true", async () => {
    const { requestId } = await seedRequest({ ageDays: 30, status: "completed" });
    expect(resolveDisplayStatus({ status: "completed", hasOpenAttention: true }).label).toBe("הושלם");
    expect(resolveDisplayStatus({ status: "cancelled", hasOpenAttention: true }).label).toBe("בוטל");

    // And a long-overdue request that COMPLETED raises no attention at all.
    const items = await getItemsNeedingReview(orgId);
    expect(items.find((i) => i.collectionRequestId === requestId)).toBeUndefined();
  });

  it("10 — the KPI is exactly the length of the list it summarises", async () => {
    await seedRequest({ ageDays: 5 });
    await seedRequest({ ageDays: 9 });
    await seedRequest({ ageDays: 0 });

    const dashboard = await getOneTimeDashboardView(orgId);

    expect(dashboard.kpis.needsReviewCount).toBe(2);
    expect(dashboard.needsAttention).toHaveLength(dashboard.kpis.needsReviewCount);
    // And the table's own badges agree with that list, row for row.
    const flagged = dashboard.inProgress.filter((row) => row.hasOpenAttention);
    expect(flagged).toHaveLength(2);
  });
});

describe("'טופל' closes one thing, and only that thing", () => {
  async function dismiss(requestId: string, kind: string, occurrenceAt: Date, sourceId = "") {
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      reasonKind: kind,
      sourceId,
      occurrenceAt,
      reasonDetail: "d",
    });
  }

  it("6 — dismissing the escalation leaves the other reason standing", async () => {
    const { requestId, conversationId } = await seedRequest({ ageDays: 5 });
    await escalateToHumanReview(orgId, requestId, "לא ענה", "system");
    await db.insert(schema.employeeReviewItems).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: requestId,
      conversationId,
      clientQuestion: "מתי?",
      category: "other",
      status: "pending",
    });

    const before = (await getItemsNeedingReview(orgId))[0];
    const escalation = before.reasons.find((r) => r.kind === "escalated")!;
    await dismiss(requestId, "escalated", escalation.occurredAt);

    const after = (await getItemsNeedingReview(orgId))[0];
    const kinds = after.reasons.map((r) => r.kind).sort();
    expect(kinds, "only the escalation was handled").toEqual(["client_overdue", "employee_question"]);
    expect((await displayedOn(requestId)).card).toBe("דורש טיפול");
  });

  it("7 — once every reason is handled, the request is no longer 'דורש טיפול' anywhere", async () => {
    const { requestId } = await seedRequest({ ageDays: 5 });
    const [item] = await getItemsNeedingReview(orgId);
    for (const reason of item.reasons) {
      await dismiss(requestId, reason.kind, reason.occurredAt, reason.sourceId ?? "");
    }

    const shown = await displayedOn(requestId);
    expect(shown.card).toBe("ממתין ללקוח");
    expect(shown.dashboard).toBe("ממתין ללקוח");
    expect(shown.inNeedsAttentionList).toBe(false);
    expect(shown.needsReviewCount).toBe(0);
  });

  it("clearing an escalation never touches the lifecycle", async () => {
    const { requestId } = await seedRequest({ ageDays: 0 });
    await escalateToHumanReview(orgId, requestId, "לא ענה", "system");

    await clearEscalation(orgId, requestId);

    const [row] = await db
      .select()
      .from(schema.collectionRequests)
      .where(eq(schema.collectionRequests.id, requestId));
    expect(row.status).toBe("waiting_for_client");
    expect(row.escalatedAt).toBeNull();
    expect((await displayedOn(requestId)).card).toBe("ממתין ללקוח");
  });
});

describe("a dismissal is not a permanent silence", () => {
  it("8 — the next overdue period raises a NEW item after the previous one was handled", async () => {
    // Being late is not one event. A client silent for three days is a
    // different situation from the same client three days later, and an
    // office that dealt with the first is entitled to hear about the second.
    const { requestId } = await seedRequest({ ageDays: 3 });
    const first = (await getItemsNeedingReview(orgId))[0].reasons.find((r) => r.kind === "client_overdue")!;
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      reasonKind: "client_overdue",
      sourceId: "",
      occurrenceAt: first.occurredAt,
      reasonDetail: "d",
    });
    expect(await getItemsNeedingReview(orgId), "handled for this period").toHaveLength(0);

    // Time passes, and the request ages into its NEXT window. The clock moves
    // rather than createdAt: the occurrence grid is anchored to when the
    // request opened, so editing that would shift every boundary including
    // the one already dismissed, and prove nothing.
    const realNow = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(realNow + HUMAN_REVIEW_WINDOW_MS);

    const reopened = await getItemsNeedingReview(orgId);
    clock.mockRestore();
    expect(reopened, "a genuine recurrence must surface again").toHaveLength(1);
    // Nothing was reopened retroactively — the old dismissal stands as history.
    expect(await db.select().from(schema.attentionDismissals)).toHaveLength(1);
  });

  it("a new failed send after a handled one reopens as its own occurrence", async () => {
    const { requestId, conversationId } = await seedRequest({ ageDays: 0 });
    const [firstFailure] = await db
      .insert(schema.messages)
      .values({
        organizationId: orgId,
        conversationId,
        direction: "outbound",
        senderType: "ai",
        body: "x",
        deliveryStatus: "failed",
        createdAt: new Date(Date.now() - 60_000),
      })
      .returning();

    const before = (await getItemsNeedingReview(orgId))[0].reasons.find((r) => r.kind === "message_failed")!;
    await db.insert(schema.attentionDismissals).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      reasonKind: "message_failed",
      sourceId: firstFailure.id,
      occurrenceAt: before.occurredAt,
      reasonDetail: "d",
    });
    expect(await getItemsNeedingReview(orgId)).toHaveLength(0);

    await db.insert(schema.messages).values({
      organizationId: orgId,
      conversationId,
      direction: "outbound",
      senderType: "ai",
      body: "y",
      deliveryStatus: "failed",
    });

    expect(await getItemsNeedingReview(orgId), "a second failure is a new problem").toHaveLength(1);
  });
});

describe("tenant isolation", () => {
  it("14 — attention never crosses organizations", async () => {
    const { requestId: mine } = await seedRequest({ ageDays: 5 });
    const { requestId: theirs } = await seedRequest({ ageDays: 5, organizationId: otherOrgId });

    const ours = await getRequestIdsNeedingAttention(orgId);
    const theirsSet = await getRequestIdsNeedingAttention(otherOrgId);

    expect(ours.has(mine)).toBe(true);
    expect(ours.has(theirs), "another tenant's request is invisible here").toBe(false);
    expect(theirsSet.has(theirs)).toBe(true);
    expect(theirsSet.has(mine)).toBe(false);
  });

  it("a dismissal recorded by another organization cannot hide this one's item", async () => {
    const { requestId } = await seedRequest({ ageDays: 5 });
    const [item] = await getItemsNeedingReview(orgId);
    await db.insert(schema.attentionDismissals).values({
      organizationId: otherOrgId,
      collectionRequestId: requestId,
      reasonKind: "client_overdue",
      sourceId: "",
      occurrenceAt: item.reasons[0].occurredAt,
      reasonDetail: "d",
    });

    expect(await getItemsNeedingReview(orgId)).toHaveLength(1);
  });
});

describe("13 — a finished request is never escalated", () => {
  it("refuses to escalate a completed request", async () => {
    const { requestId } = await seedRequest({ ageDays: 9, status: "completed" });
    expect(await escalateToHumanReview(orgId, requestId, "לא ענה", "system")).toBe(false);
  });

  it("refuses to escalate a cancelled request", async () => {
    const { requestId } = await seedRequest({ ageDays: 9, status: "cancelled" });
    expect(await escalateToHumanReview(orgId, requestId, "לא ענה", "system")).toBe(false);
  });

  it("a request with every document in never counts as overdue", async () => {
    const { requestId } = await seedRequest({ ageDays: 30, withRequirement: false });

    const items = await getItemsNeedingReview(orgId);
    expect(items.find((i) => i.collectionRequestId === requestId)).toBeUndefined();
  });

  it("a draft is never overdue — it was never sent", async () => {
    const { requestId } = await seedRequest({ ageDays: 30, status: "draft" });

    const items = await getItemsNeedingReview(orgId);
    expect(items.find((i) => i.collectionRequestId === requestId)).toBeUndefined();
  });

  it("a deferral the CLIENT asked for suspends the overdue clock", async () => {
    const { requestId, conversationId } = await seedRequest({ ageDays: 9 });
    expect(await getItemsNeedingReview(orgId)).toHaveLength(1);

    await db
      .update(schema.conversations)
      .set({
        deferredReminderAt: new Date(Date.now() + DAY_MS),
        deferredReminderOriginalText: "אשלח מחר",
      })
      .where(eq(schema.conversations.id, conversationId));

    expect(
      await getItemsNeedingReview(orgId),
      "the office agreed to wait — nagging about waiting is wrong"
    ).toHaveLength(0);
  });
});
