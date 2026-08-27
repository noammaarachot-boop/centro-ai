import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { seedApprovedWhatsAppTemplates } from "@/test/whatsappFixtures";

// Multi-active-collection-request disambiguation — unit/integration
// coverage for the resolver logic itself (src/lib/requestDisambiguation.ts),
// independent of the full webhook wire-up (covered separately by
// src/e2e/documentCollection.e2e.test.ts's own "Multi-active-collection-
// request disambiguation" describe block). vi.mock calls are hoisted
// above every import in this file regardless of where they're written —
// declared at true top level, matching this repo's established pattern.

let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const sendTextMessage = vi.fn();
vi.mock("@/lib/whatsapp/send", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/send")>("@/lib/whatsapp/send");
  return {
    ...actual,
    sendTextMessage: (...args: unknown[]) => sendTextMessage(...args),
    sendInteractiveButtonsMessage: vi.fn(),
    sendTemplateMessage: vi.fn(),
  };
});

const {
  resolveClientConversation,
  tryUnambiguousMatchByOpenQuestion,
  createRequestDisambiguation,
  findOpenDisambiguationForClient,
  resolveDisambiguationReply,
  resendDisambiguationClarification,
  mostRecentlyActiveOpenConversation,
} = await import("./requestDisambiguation");

beforeAll(async () => {
  const client = await createMigratedPglite();
  db = drizzle(client, { schema }) as unknown as Database;
}, 60_000);

beforeEach(() => {
  sendTextMessage.mockReset();
  sendTextMessage.mockResolvedValue({ messageId: "wamid.out" });
});

async function seedOrgAndClient() {
  const [org] = await db
    .insert(schema.organizations)
    .values({ name: "Org", whatsappPhoneNumberId: `phone-${crypto.randomUUID()}`, documentCollectionEnabled: true })
    .returning();
  await seedApprovedWhatsAppTemplates(db, org.id);
  const [client] = await db
    .insert(schema.clients)
    .values({ organizationId: org.id, name: "לקוח", phone: "+972500000000" })
    .returning();
  return { orgId: org.id, clientId: client.id };
}

async function seedRequestAndConversation(
  orgId: string,
  clientId: string,
  options: { periodLabel: string; conversationStatus?: "open" | "waiting_for_client" | "human_control" | "closed"; updatedAt?: Date }
) {
  const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: `שירות ${options.periodLabel}` }).returning();
  const [request] = await db
    .insert(schema.collectionRequests)
    .values({ organizationId: orgId, clientId, serviceId: service.id, periodLabel: options.periodLabel, status: "active" })
    .returning();
  const [conversation] = await db
    .insert(schema.conversations)
    .values({
      organizationId: orgId,
      clientId,
      collectionRequestId: request.id,
      status: options.conversationStatus ?? "open",
      ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
    })
    .returning();
  return { requestId: request.id, conversationId: conversation.id, serviceId: service.id };
}

describe("resolveClientConversation", () => {
  it("returns no_conversation for a client with zero conversations", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const result = await resolveClientConversation(orgId, clientId);
    expect(result.outcome).toBe("no_conversation");
  });

  it("returns resolved directly for a client with exactly one conversation, regardless of status", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const { conversationId } = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P1" });
    const result = await resolveClientConversation(orgId, clientId);
    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.conversation.id).toBe(conversationId);
  });

  it("returns ambiguous when two conversations are both genuinely open at once", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    const reqY = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y", conversationStatus: "waiting_for_client" });

    const result = await resolveClientConversation(orgId, clientId);

    expect(result.outcome).toBe("ambiguous");
    if (result.outcome === "ambiguous") {
      const ids = result.candidates.map((c) => c.collectionRequestId).sort();
      expect(ids).toEqual([reqX.requestId, reqY.requestId].sort());
    }
  });

  it("preserves the pre-existing behavior when only one conversation is currently non-closed (the other already closed)", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-old", conversationStatus: "closed" });
    const live = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-live", conversationStatus: "open" });

    const result = await resolveClientConversation(orgId, clientId);

    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.conversation.id).toBe(live.conversationId);
  });

  it("when every conversation is closed, preserves the original most-recently-updated behavior unchanged (separate, already-scoped post-completion situation)", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, {
      periodLabel: "P-older",
      conversationStatus: "closed",
      updatedAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedRequestAndConversation(orgId, clientId, {
      periodLabel: "P-newer",
      conversationStatus: "closed",
      updatedAt: new Date(),
    });

    const result = await resolveClientConversation(orgId, clientId);

    expect(result.outcome).toBe("resolved");
    if (result.outcome === "resolved") expect(result.conversation.id).toBe(newer.conversationId);
  });

  it("never returns a conversation belonging to a different organization or client", async () => {
    const { orgId: orgA, clientId: clientA } = await seedOrgAndClient();
    const { orgId: orgB, clientId: clientB } = await seedOrgAndClient();
    await seedRequestAndConversation(orgA, clientA, { periodLabel: "A" });
    await seedRequestAndConversation(orgB, clientB, { periodLabel: "B" });

    const resultA = await resolveClientConversation(orgA, clientA);
    const resultB = await resolveClientConversation(orgB, clientB);

    expect(resultA.outcome).toBe("resolved");
    expect(resultB.outcome).toBe("resolved");
    if (resultA.outcome === "resolved" && resultB.outcome === "resolved") {
      expect(resultA.conversation.organizationId).toBe(orgA);
      expect(resultB.conversation.organizationId).toBe(orgB);
    }
  });
});

describe("tryUnambiguousMatchByOpenQuestion", () => {
  it("returns the one candidate with an open question when the other has none", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    const reqY = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    await db.insert(schema.pendingConfirmations).values({
      organizationId: orgId,
      clientId,
      collectionRequestId: reqX.requestId,
      conversationId: reqX.conversationId,
      kind: "unsolicited_document",
      payload: {},
      question: "?",
      status: "pending",
    });

    const result = await resolveClientConversation(orgId, clientId);
    expect(result.outcome).toBe("ambiguous");
    if (result.outcome !== "ambiguous") return;
    const match = await tryUnambiguousMatchByOpenQuestion(result.candidates);
    expect(match?.collectionRequestId).toBe(reqX.requestId);
    void reqY;
  });

  it("returns null when neither candidate has an open question", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });

    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    const match = await tryUnambiguousMatchByOpenQuestion(result.candidates);
    expect(match).toBeNull();
  });

  it("returns null when both candidates have an open question — still ambiguous, never guesses", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    const reqY = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    for (const req of [reqX, reqY]) {
      await db.insert(schema.pendingConfirmations).values({
        organizationId: orgId,
        clientId,
        collectionRequestId: req.requestId,
        conversationId: req.conversationId,
        kind: "unsolicited_document",
        payload: {},
        question: "?",
        status: "pending",
      });
    }

    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    const match = await tryUnambiguousMatchByOpenQuestion(result.candidates);
    expect(match).toBeNull();
  });
});

describe("createRequestDisambiguation / resolveDisambiguationReply", () => {
  it("holds the content, sends a numbered clarification naming every candidate, and touches no candidate request", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    const reqY = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });

    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");

    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: "מסמך כלשהו",
      attachment: null,
      whatsappMessageId: null,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const sentBody = sendTextMessage.mock.calls[0][2] as string;
    expect(sentBody).toContain("P-X");
    expect(sentBody).toContain("P-Y");

    const held = await findOpenDisambiguationForClient(orgId, clientId);
    expect(held).not.toBeNull();
    expect(held!.resolvedAt).toBeNull();
    expect(held!.messageBody).toBe("מסמך כלשהו");

    // Neither candidate request's own status/documents were touched.
    const [rowX] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, reqX.requestId));
    const [rowY] = await db.select().from(schema.collectionRequests).where(eq(schema.collectionRequests.id, reqY.requestId));
    expect(rowX.status).toBe("active");
    expect(rowY.status).toBe("active");
  });

  it("resolves with a valid numbered reply and returns the held content tied to the right collectionRequestId", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: "מסמך כלשהו",
      attachment: null,
      whatsappMessageId: null,
    });

    const held = (await findOpenDisambiguationForClient(orgId, clientId))!;
    const choiceIndex = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;

    const resolution = await resolveDisambiguationReply(held, String(choiceIndex));

    expect(resolution).not.toBeNull();
    expect(resolution!.collectionRequestId).toBe(reqX.requestId);
    expect(resolution!.messageBody).toBe("מסמך כלשהו");
    const stillOpen = await findOpenDisambiguationForClient(orgId, clientId);
    expect(stillOpen).toBeNull(); // resolved, no longer open
  });

  it("never guesses — an unparseable or out-of-range reply resolves to null so the caller re-asks", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: null,
      attachment: null,
      whatsappMessageId: null,
    });
    const held = (await findOpenDisambiguationForClient(orgId, clientId))!;

    expect(await resolveDisambiguationReply(held, "מה זה?")).toBeNull(); // no number at all
    expect(await resolveDisambiguationReply(held, "5")).toBeNull(); // out of range (only 2 candidates)
    expect(await resolveDisambiguationReply(held, "1 או 2")).toBeNull(); // two distinct numbers — genuinely ambiguous

    // Still open after every failed attempt — never silently resolved.
    const stillOpen = await findOpenDisambiguationForClient(orgId, clientId);
    expect(stillOpen).not.toBeNull();
  });

  // Root-cause fix (production incident, 2026-08-13) — resolveDisambiguationReply
  // now also accepts Hebrew ordinal words and an unambiguous name match, not
  // only a literal digit. These reproduce the user's own scenarios A-D.
  describe("accepts ordinal words and name matches, not only a literal digit", () => {
    async function seedTwoCandidatesAndAsk(orgId: string, clientId: string) {
      const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "פתיחת תיק — אוגוסט 2026" });
      const reqY = await seedRequestAndConversation(orgId, clientId, { periodLabel: "בדיקת V2 — אוגוסט 2026" });
      const result = await resolveClientConversation(orgId, clientId);
      if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
      await createRequestDisambiguation({
        organizationId: orgId,
        clientId,
        candidates: result.candidates,
        messageBody: null,
        attachment: null,
        whatsappMessageId: null,
      });
      const held = (await findOpenDisambiguationForClient(orgId, clientId))!;
      return { held, reqX, reqY };
    }

    // Candidates are ordered by most-recently-updated first (same ordering
    // resolveClientConversation always uses), not by seeding order — these
    // derive the real 1-based position from the held row itself, the same
    // way this file's own pre-existing tests already do (see "resolves
    // with a valid numbered reply" above), rather than assuming which of
    // reqX/reqY ends up first.
    it("A. a literal reply with the first candidate's own number resolves to it", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      const { held, reqX } = await seedTwoCandidatesAndAsk(orgId, clientId);
      const choiceIndex = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;
      const resolution = await resolveDisambiguationReply(held, String(choiceIndex));
      expect(resolution?.collectionRequestId).toBe(reqX.requestId);
    });

    it("B. a literal reply with the second candidate's own number resolves to it", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      const { held, reqY } = await seedTwoCandidatesAndAsk(orgId, clientId);
      const choiceIndex = held.candidateCollectionRequestIds.indexOf(reqY.requestId) + 1;
      const resolution = await resolveDisambiguationReply(held, String(choiceIndex));
      expect(resolution?.collectionRequestId).toBe(reqY.requestId);
    });

    it("C. Hebrew ordinal words ('הראשונה'/'השנייה') resolve to the matching candidate", async () => {
      const ORDINALS = ["הראשונה", "השנייה"];
      const { orgId, clientId } = await seedOrgAndClient();
      const { held, reqX } = await seedTwoCandidatesAndAsk(orgId, clientId);
      const choiceIndex = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;
      const resolution = await resolveDisambiguationReply(held, ORDINALS[choiceIndex - 1]);
      expect(resolution?.collectionRequestId).toBe(reqX.requestId);
    });

    it("D. text naming one candidate's own label unambiguously resolves to it", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      const { held, reqY } = await seedTwoCandidatesAndAsk(orgId, clientId);
      const resolution = await resolveDisambiguationReply(held, "אני מתכוון לבדיקת V2");
      expect(resolution?.collectionRequestId).toBe(reqY.requestId);
    });

    it("text that matches BOTH candidates' shared wording still resolves to null — never guesses", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      const { held } = await seedTwoCandidatesAndAsk(orgId, clientId);
      // "אוגוסט 2026" alone is the common suffix of both labels — not a
      // valid discriminator for either one specifically.
      expect(await resolveDisambiguationReply(held, "אוגוסט 2026")).toBeNull();
    });
  });

  describe("mostRecentlyActiveOpenConversation", () => {
    it("returns the most recently updated OPEN conversation among several", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-old", updatedAt: new Date(Date.now() - 120_000) });
      const newest = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-newest", updatedAt: new Date() });
      const result = await mostRecentlyActiveOpenConversation(orgId, clientId);
      expect(result?.id).toBe(newest.conversationId);
    });

    it("skips closed conversations even if they're the most recently updated", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      const openOne = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-open", updatedAt: new Date(Date.now() - 60_000) });
      await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-closed", conversationStatus: "closed", updatedAt: new Date() });
      const result = await mostRecentlyActiveOpenConversation(orgId, clientId);
      expect(result?.id).toBe(openOne.conversationId);
    });

    it("returns null for a client with no conversations at all", async () => {
      const { orgId, clientId } = await seedOrgAndClient();
      expect(await mostRecentlyActiveOpenConversation(orgId, clientId)).toBeNull();
    });
  });

  it("resendDisambiguationClarification re-sends the same options without creating a second held row", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: null,
      attachment: null,
      whatsappMessageId: null,
    });
    sendTextMessage.mockClear();

    const held = (await findOpenDisambiguationForClient(orgId, clientId))!;
    await resendDisambiguationClarification(held);

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    const allOpen = await db
      .select()
      .from(schema.pendingRequestDisambiguations)
      .where(eq(schema.pendingRequestDisambiguations.clientId, clientId));
    expect(allOpen).toHaveLength(1); // still just the one row, not duplicated
  });

  it("a second concurrent resolve attempt on the same held row loses the race — only one wins (atomic claim)", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    const reqX = await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: null,
      attachment: null,
      whatsappMessageId: null,
    });
    const held = (await findOpenDisambiguationForClient(orgId, clientId))!;
    const choiceIndex = held.candidateCollectionRequestIds.indexOf(reqX.requestId) + 1;

    const [first, second] = await Promise.all([
      resolveDisambiguationReply(held, String(choiceIndex)),
      resolveDisambiguationReply(held, String(choiceIndex)),
    ]);

    const resolvedCount = [first, second].filter((r) => r !== null).length;
    expect(resolvedCount).toBe(1);
  });

  it("only one open disambiguation can exist per client at a time (partial unique index)", async () => {
    const { orgId, clientId } = await seedOrgAndClient();
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-X" });
    await seedRequestAndConversation(orgId, clientId, { periodLabel: "P-Y" });
    const result = await resolveClientConversation(orgId, clientId);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");

    await createRequestDisambiguation({
      organizationId: orgId,
      clientId,
      candidates: result.candidates,
      messageBody: "first",
      attachment: null,
      whatsappMessageId: null,
    });

    await expect(
      createRequestDisambiguation({
        organizationId: orgId,
        clientId,
        candidates: result.candidates,
        messageBody: "second",
        attachment: null,
        whatsappMessageId: null,
      })
    ).rejects.toThrow();
  });

  it("isolation: a disambiguation held for one client is invisible to another client, even in the same organization", async () => {
    const { orgId, clientId: clientA } = await seedOrgAndClient();
    const [clientB] = await db.insert(schema.clients).values({ organizationId: orgId, name: "לקוח ב", phone: "+972500000001" }).returning();
    await seedRequestAndConversation(orgId, clientA, { periodLabel: "A-X" });
    await seedRequestAndConversation(orgId, clientA, { periodLabel: "A-Y" });
    const result = await resolveClientConversation(orgId, clientA);
    if (result.outcome !== "ambiguous") throw new Error("expected ambiguous");
    await createRequestDisambiguation({
      organizationId: orgId,
      clientId: clientA,
      candidates: result.candidates,
      messageBody: null,
      attachment: null,
      whatsappMessageId: null,
    });

    expect(await findOpenDisambiguationForClient(orgId, clientA)).not.toBeNull();
    expect(await findOpenDisambiguationForClient(orgId, clientB.id)).toBeNull();
  });
});
