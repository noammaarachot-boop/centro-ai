import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import type { RequirementSemanticSpec } from "@/lib/ai/requirementSemantics";

// Semantic requirement engine — snapshotServiceRequirements is the one
// place a reusable template's parsed semanticSpec/requiredCount actually
// reach a real Collection Request, with any month-only period ("06" for
// "יוני") resolved into a concrete "MM/YYYY" anchored to this specific
// request's own creation moment.

let db: Database;

vi.mock("@/db", () => ({
  getDb: async () => db,
}));

const { snapshotServiceRequirements, applyTransition, completeCollectionRequest } = await import(
  "./collectionRequestStateMachine"
);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema }) as unknown as Database;
  await migrate(db as never, { migrationsFolder: "./drizzle" });
}, 60_000);

async function seedServiceWithRequirement(
  requirementOverrides: Partial<{ requiredCount: number; semanticSpec: RequirementSemanticSpec | null }>
) {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  await db.insert(schema.serviceDocumentRequirements).values({
    serviceId: service.id,
    name: "תלוש שכר",
    requiredCount: requirementOverrides.requiredCount ?? 1,
    semanticSpec: requirementOverrides.semanticSpec ?? null,
  });
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p" })
    .returning();
  return { orgId: org.id, clientId: client.id, serviceId: service.id, requestId: request.id };
}

describe("snapshotServiceRequirements — semantic requirement engine propagation", () => {
  it("copies requiredCount and semanticSpec from the template onto the request's own requirement row", async () => {
    const spec: RequirementSemanticSpec = {
      originalText: "3 תלושי שכר של 3 החודשים האחרונים",
      documentType: "תלוש שכר",
      requiredCount: 3,
      periodType: "relative",
      explicitPeriods: null,
      relativePeriod: { kind: "last_n_months", n: 3 },
      samePeriodAllowed: false,
      distinctPeriodsRequired: true,
      distinctPeopleRequired: false,
      expectedPersonOrCompany: null,
      validityRequirement: null,
      supportingDocumentRelationship: null,
      freeTextConstraints: null,
      interpretationConfidence: 0.9,
      clarifyingQuestion: null,
    };
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 3, semanticSpec: spec });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    expect(row.requiredCount).toBe(3);
    const snapshotSpec = row.semanticSpec as RequirementSemanticSpec;
    expect(snapshotSpec.periodType).toBe("relative");
    expect(snapshotSpec.distinctPeriodsRequired).toBe(true);
  });

  it("resolves a month-only explicitPeriods entry into a concrete MM/YYYY anchored to the request's own creation date", async () => {
    const spec: RequirementSemanticSpec = {
      originalText: "3 תלושי שכר של חודש יוני",
      documentType: "תלוש שכר",
      requiredCount: 3,
      periodType: "explicit",
      explicitPeriods: ["06"], // month-only, no year — template has no request date to anchor to
      relativePeriod: null,
      samePeriodAllowed: true,
      distinctPeriodsRequired: false,
      distinctPeopleRequired: false,
      expectedPersonOrCompany: null,
      validityRequirement: null,
      supportingDocumentRelationship: null,
      freeTextConstraints: null,
      interpretationConfidence: 0.9,
      clarifyingQuestion: null,
    };
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 3, semanticSpec: spec });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    const snapshotSpec = row.semanticSpec as RequirementSemanticSpec;
    expect(snapshotSpec.explicitPeriods).toHaveLength(1);
    expect(snapshotSpec.explicitPeriods![0]).toMatch(/^06\/\d{4}$/);
  });

  it("a requirement with no semanticSpec (legacy row) snapshots with a null spec, requiredCount preserved", async () => {
    const { orgId, clientId, serviceId, requestId } = await seedServiceWithRequirement({ requiredCount: 1, semanticSpec: null });

    await snapshotServiceRequirements(requestId, serviceId, orgId, clientId);

    const [row] = await db
      .select()
      .from(schema.collectionRequestRequirements)
      .where(eq(schema.collectionRequestRequirements.collectionRequestId, requestId));
    expect(row.requiredCount).toBe(1);
    expect(row.semanticSpec).toBeNull();
  });
});

async function seedRequestWithConversation(status: "active" | "waiting_for_client" | "processing" | "escalated" = "active") {
  const [org] = await db.insert(schema.organizations).values({ name: "Org" }).returning();
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: `+9725${Math.floor(Math.random() * 100000000)}` })
    .returning();
  const [service] = await db.insert(schema.services).values({ organizationId: org.id, name: "Service" }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: org.id, clientId: client.id, serviceId: service.id, periodLabel: "p", status })
    .returning();
  const [requirement] = await db
    .insert(schema.collectionRequestRequirements)
    .values({ collectionRequestId: request.id, name: "תעודת זהות" })
    .returning();
  const staleAnchor = new Date(Date.now() - 999 * 60 * 60 * 1000);
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: org.id,
      clientId: client.id,
      collectionRequestId: request.id,
      status: status === "waiting_for_client" ? "waiting_for_client" : "open",
      reminderAnchorAt: staleAnchor,
      deferredReminderAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return { orgId: org.id, clientId: client.id, requestId: request.id, requirementId: requirement.id, conversationId: conversation.id, staleAnchor };
}

// Root-cause fix (2026-08-16 production incident) — completeCollectionRequest
// used to always transition to "processing" first, then attempt
// processing -> completed; a failure at the second step (real requirements
// still outstanding) left the request permanently stuck in "processing"
// with no legal way back to "active", invisible to every scheduler pass.
describe("completeCollectionRequest — never strands a genuinely incomplete request in 'processing'", () => {
  it("an incomplete request (no approved documents) stays exactly at its current status — never silently moves to 'processing'", async () => {
    const { orgId, requestId } = await seedRequestWithConversation("active");

    const result = await completeCollectionRequest(orgId, undefined, "system", requestId);

    expect(result.ok).toBe(false);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("active"); // NOT "processing" — the bug this test guards against
  });

  it("a genuinely complete request (all requirements approved) still completes normally through the processing step", async () => {
    const { orgId, requestId, requirementId } = await seedRequestWithConversation("active");
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    const result = await completeCollectionRequest(orgId, undefined, "system", requestId);

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("completed");
  });

  it("a request already stuck in 'processing' from before this fix is left untouched (not silently force-completed) when still genuinely incomplete", async () => {
    const { orgId, requestId } = await seedRequestWithConversation("processing");

    const result = await completeCollectionRequest(orgId, undefined, "system", requestId);

    expect(result.ok).toBe(false);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("processing"); // this fix prevents NEW stranding; recovering an already-stuck row is a separate, explicit data-fix step
  });
});

// Explicit resend (2026-08-16) — "only an explicit resend reopens a new
// lifecycle": an employee moving a request out of "escalated" back to
// "active" resets the automation clock; every other transition leaves it
// untouched.
describe("applyTransition — explicit resend from 'escalated' back to 'active' starts a fresh automation cycle", () => {
  it("resets reviewDeadlineAt to a fresh 3-day window and deferralCount to 0", async () => {
    const { orgId, requestId } = await seedRequestWithConversation("escalated");
    await db
      .update(schema.collectionRequests)
      .set({ reviewDeadlineAt: new Date(Date.now() - 60 * 60 * 1000), deferralCount: 2, escalationReason: "לא ענה" })
      .where(eq(schema.collectionRequests.id, requestId));

    const before = Date.now();
    const result = await applyTransition(orgId, undefined, "employee", requestId, "active");

    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.status).toBe("active");
    expect(after.deferralCount).toBe(0);
    expect(after.escalationReason).toBeNull();
    expect(after.reviewDeadlineAt!.getTime()).toBeGreaterThan(before); // fresh 3-day window, not the stale/past one
    expect(after.reviewDeadlineAt!.getTime()).toBeGreaterThan(before + 2.9 * 24 * 60 * 60 * 1000);
  });

  it("also resets the conversation's own reminderAnchorAt and clears any leftover deferredReminderAt", async () => {
    const { orgId, requestId, conversationId, staleAnchor } = await seedRequestWithConversation("escalated");

    const before = Date.now();
    await applyTransition(orgId, undefined, "employee", requestId, "active");

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.reminderAnchorAt.getTime()).toBeGreaterThan(before);
    expect(conversation.reminderAnchorAt.getTime()).not.toBe(staleAnchor.getTime());
    expect(conversation.deferredReminderAt).toBeNull();
  });

  it("does NOT reset the cycle for any other transition (e.g. active -> waiting_for_client already has its own fresh-window rule; escalated -> waiting_for_client is a different target, not 'active')", async () => {
    const { orgId, requestId } = await seedRequestWithConversation("escalated");
    const originalDeadline = new Date(Date.now() - 60 * 60 * 1000);
    await db
      .update(schema.collectionRequests)
      .set({ reviewDeadlineAt: originalDeadline, deferralCount: 1 })
      .where(eq(schema.collectionRequests.id, requestId));

    // escalated -> waiting_for_client already gets ITS OWN fresh-window
    // reset (the pre-existing, unrelated waiting_for_client rule) — this
    // just confirms the resend-specific branch isn't double-applying or
    // interfering with that separate, already-tested rule.
    const result = await applyTransition(orgId, undefined, "employee", requestId, "waiting_for_client");
    expect(result.ok).toBe(true);
    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.deferralCount).toBe(0); // reset by the waiting_for_client rule, not the resend rule
  });
});

// Completion lifecycle closure (root-cause fix) — centralized in
// applyTransition itself, the one low-level function every path to
// "completed" goes through (including a direct employee status change via
// transitionStatus, which used to bypass caseReview.ts's own
// conversation-closing entirely). Reaching "completed" must always close
// the conversation and resolve any stale pending review item, regardless
// of which of the several call sites triggered it.
describe("applyTransition — completing a request closes its conversation and cleans up stale active state (root-cause fix)", () => {
  it("sets the conversation to closed and clears deferredReminderAt/pendingCaseReviewAt", async () => {
    const { orgId, requestId, requirementId, conversationId } = await seedRequestWithConversation("active");
    await db
      .update(schema.conversations)
      .set({ deferredReminderAt: new Date(Date.now() + 60 * 60 * 1000), pendingCaseReviewAt: new Date(Date.now() + 60 * 1000) })
      .where(eq(schema.conversations.id, conversationId));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    const result = await completeCollectionRequest(orgId, undefined, "system", requestId);
    expect(result.ok).toBe(true);

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
    expect(conversation.deferredReminderAt).toBeNull();
    expect(conversation.pendingCaseReviewAt).toBeNull();
  });

  it("closes the conversation even when completed via a direct employee status change (transitionStatus's own call shape), not just the caseReview.ts path", async () => {
    const { orgId, requestId, requirementId, conversationId } = await seedRequestWithConversation("active");
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    // The exact two-step shape transitionStatus (collections/actions.ts)
    // uses — applyTransition directly, never attemptFinishCollectionRequest
    // — which is precisely the gap that used to leave the conversation open.
    const toProcessing = await applyTransition(orgId, undefined, "employee", requestId, "processing");
    expect(toProcessing.ok).toBe(true);
    const toCompleted = await applyTransition(orgId, undefined, "employee", requestId, "completed");
    expect(toCompleted.ok).toBe(true);

    const [conversation] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(conversation.status).toBe("closed");
  });

  it("resolves any still-pending employeeReviewItem tied to the request, without sending a client message, and records an audit event", async () => {
    const { orgId, clientId, requestId, requirementId, conversationId } = await seedRequestWithConversation("active");
    const [reviewItem] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: orgId,
        clientId,
        collectionRequestId: requestId,
        conversationId,
        clientQuestion: "מתי אתם פותחים את התיק?",
        category: "human_request",
        status: "pending",
      })
      .returning();
    const messagesBefore = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    const result = await completeCollectionRequest(orgId, undefined, "system", requestId);
    expect(result.ok).toBe(true);

    const [after] = await db.select().from(schema.employeeReviewItems).where(eq(schema.employeeReviewItems.id, reviewItem.id));
    expect(after.status).toBe("resolved");
    expect(after.resolvedBy).toBe("ai_context");
    expect(after.resolvedByUserId).toBeNull();

    // No message sent to the client about it — the completion message
    // (sent separately, by caseReview.ts's finalizeCompletion) is the only
    // outbound message this whole flow produces.
    const messagesAfter = await db.select().from(schema.messages).where(eq(schema.messages.conversationId, conversationId));
    const newOutbound = messagesAfter.filter((m) => m.direction === "outbound" && !messagesBefore.some((b) => b.id === m.id));
    expect(newOutbound.every((m) => !m.body.includes("מתי אתם פותחים"))).toBe(true);

    const audit = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.collectionRequestId, requestId));
    expect(audit.some((a) => a.eventType === "review_item.auto_resolved_by_completion")).toBe(true);
  });

  it("never touches a pending employeeReviewItem belonging to a DIFFERENT request", async () => {
    const requestA = await seedRequestWithConversation("active");
    const requestB = await seedRequestWithConversation("active");
    const [reviewItemB] = await db
      .insert(schema.employeeReviewItems)
      .values({
        organizationId: requestB.orgId,
        clientId: requestB.clientId,
        collectionRequestId: requestB.requestId,
        conversationId: requestB.conversationId,
        clientQuestion: "שאלה על בקשה אחרת",
        category: "other",
        status: "pending",
      })
      .returning();
    await db.insert(schema.documents).values({
      organizationId: requestA.orgId,
      collectionRequestId: requestA.requestId,
      requirementId: requestA.requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    await completeCollectionRequest(requestA.orgId, undefined, "system", requestA.requestId);

    const [stillPending] = await db
      .select()
      .from(schema.employeeReviewItems)
      .where(eq(schema.employeeReviewItems.id, reviewItemB.id));
    expect(stillPending.status).toBe("pending");
  });

  it("clears extensionActive back to false on completion", async () => {
    const { orgId, requestId, requirementId } = await seedRequestWithConversation("active");
    await db.update(schema.collectionRequests).set({ extensionActive: true }).where(eq(schema.collectionRequests.id, requestId));
    await db.insert(schema.documents).values({
      organizationId: orgId,
      collectionRequestId: requestId,
      requirementId,
      fileName: "id.pdf",
      status: "approved",
    });

    await completeCollectionRequest(orgId, undefined, "system", requestId);

    const [after] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, requestId));
    expect(after.extensionActive).toBe(false);
  });
});
