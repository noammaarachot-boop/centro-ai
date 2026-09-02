import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createMigratedPglite } from "@/test/pgliteSnapshot";
import * as schema from "@/db/schema";
import type { Database } from "@/db";
import { withAiContext, withAiOperation, getAiCallContext } from "./context";

/**
 * Every AI call is measured, and measuring never breaks the product.
 *
 * The audit that produced this could not answer "what did Anthropic cost me
 * today, and what caused it": token usage existed for the assistant alone,
 * while twelve classifiers called the provider and recorded nothing. Their
 * absence had to be INFERRED from the absence of inbound traffic — reasoning,
 * not measurement. These tests pin the two properties that replace that:
 * a call cannot avoid being recorded, and a recording failure cannot take
 * down the business operation it was observing.
 */
let db: Database;
vi.mock("@/db", () => ({ getDb: async () => db }));

const { recordAiUsage, classifyErrorKind, currentEnvironment } = await import("./record");
const { usageRecordingMiddleware } = await import("./middleware");

beforeAll(async () => {
  db = drizzle(await createMigratedPglite(), { schema }) as unknown as Database;
}, 60_000);

let orgId: string;

beforeEach(async () => {
  await db.delete(schema.aiUsageEvents);
  await db.delete(schema.organizations);
  const [org] = await db.insert(schema.organizations).values({ name: "משרד" }).returning();
  orgId = org.id;
});

const rows = async () => db.select().from(schema.aiUsageEvents);

/** The usage shape the provider SDK actually reports. */
const usage = (input: number, output: number, extra: Record<string, number> = {}) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined, ...extra },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

function middleware() {
  return usageRecordingMiddleware("anthropic", "claude-sonnet-5");
}

/** Invokes the middleware the way the SDK does. */
async function runThroughMiddleware(doGenerate: () => Promise<unknown>) {
  const mw = middleware();
  return mw.wrapGenerate!({
    doGenerate: doGenerate as never,
    doStream: (() => {}) as never,
    params: {} as never,
    model: {} as never,
  });
}

describe("what gets recorded", () => {
  it("records tokens, model, latency and success for a normal call", async () => {
    await withAiContext({ organizationId: orgId }, () =>
      withAiOperation("document.vision_classify", () =>
        runThroughMiddleware(async () => ({ usage: usage(1500, 300) }))
      )
    );

    const [row] = await rows();
    expect(row.operation).toBe("document.vision_classify");
    expect(row.organizationId).toBe(orgId);
    expect(row.provider).toBe("anthropic");
    expect(row.modelId).toBe("claude-sonnet-5");
    expect(row.inputTokens).toBe(1500);
    expect(row.outputTokens).toBe(300);
    expect(row.totalTokens, "summed when the provider gives no total").toBe(1800);
    expect(row.success).toBe(true);
    expect(row.attempt).toBe(1);
    expect(row.latencyMs).toBeGreaterThanOrEqual(0);
    expect(row.environment).toBeTruthy();
  });

  it("keeps cache reads and writes apart, because they are priced differently", async () => {
    await withAiOperation("conversation.understand_turn", () =>
      runThroughMiddleware(async () => ({
        usage: usage(1000, 100, { cacheRead: 800, cacheWrite: 120 }),
      }))
    );

    const [row] = await rows();
    expect(row.cachedInputTokens).toBe(800);
    expect(row.cacheWriteTokens).toBe(120);
  });

  it("records null, not zero, when the provider reports no usage", async () => {
    // Zero would claim the call was free. "We were not told" is a different
    // statement and the table must be able to make it.
    await withAiOperation("conversation.classify_yes_no", () =>
      runThroughMiddleware(async () => ({ usage: undefined }))
    );

    const [row] = await rows();
    expect(row.inputTokens).toBeNull();
    expect(row.outputTokens).toBeNull();
    expect(row.totalTokens).toBeNull();
  });

  it("carries the request and conversation a call belongs to", async () => {
    const [client] = await db
      .insert(schema.clients)
      .values({ organizationId: orgId, name: "c", phone: "+972500000001" })
      .returning();
    const [service] = await db.insert(schema.services).values({ organizationId: orgId, name: "s" }).returning();
    const [request] = await db
      .insert(schema.collectionRequests)
      .values({ organizationId: orgId, clientId: client.id, serviceId: service.id, periodLabel: "p" })
      .returning();
    const [conversation] = await db
      .insert(schema.conversations)
      .values({ organizationId: orgId, clientId: client.id, collectionRequestId: request.id })
      .returning();

    await withAiContext(
      { organizationId: orgId, collectionRequestId: request.id, conversationId: conversation.id },
      () => withAiOperation("conversation.understand_turn", () => runThroughMiddleware(async () => ({ usage: usage(1, 1) })))
    );

    const [row] = await rows();
    expect(row.collectionRequestId).toBe(request.id);
    expect(row.conversationId).toBe(conversation.id);
  });
});

describe("failures and retries", () => {
  it("records a failed call and re-throws it unchanged", async () => {
    class RateLimitError extends Error {}

    await expect(
      withAiOperation("policy.match_question", () =>
        runThroughMiddleware(async () => {
          throw new RateLimitError("secret prompt content that must not be stored");
        })
      )
    ).rejects.toBeInstanceOf(RateLimitError);

    const [row] = await rows();
    expect(row.success).toBe(false);
    expect(row.errorKind).toBe("RateLimitError");
    // The message can quote the payload back — a client's document or
    // conversation — so a cost table must never become a second home for it.
    expect(JSON.stringify(row)).not.toContain("secret prompt content");
  });

  it("counts each retry as its own billed call", async () => {
    // The SDK retries by invoking the model again, so one logical call can
    // bill three times. Measuring at the call site would report one.
    await withAiOperation("conversation.classify_deferral", async () => {
      await runThroughMiddleware(async () => ({ usage: usage(10, 1) }));
      await runThroughMiddleware(async () => ({ usage: usage(10, 1) }));
      await runThroughMiddleware(async () => ({ usage: usage(10, 1) }));
    });

    const recorded = await rows();
    expect(recorded).toHaveLength(3);
    expect(recorded.map((r) => r.attempt).sort()).toEqual([1, 2, 3]);
  });

  it("a separate operation starts its own attempt count", async () => {
    await withAiOperation("policy.match_question", () => runThroughMiddleware(async () => ({ usage: usage(1, 1) })));
    await withAiOperation("policy.render_answer", () => runThroughMiddleware(async () => ({ usage: usage(1, 1) })));

    const recorded = await rows();
    expect(recorded.every((r) => r.attempt === 1), "two calls, not one call retried").toBe(true);
  });
});

describe("telemetry never breaks the business operation", () => {
  it("a recording failure does not fail the AI call", async () => {
    const broken = { insert: () => { throw new Error("database is down"); } } as unknown as Database;
    const real = db;
    db = broken;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await withAiOperation("document.vision_classify", () =>
        runThroughMiddleware(async () => ({ usage: usage(1, 1), value: "classified" }))
      );
      // The provider's answer is returned intact — a cost table that can
      // break document classification is worse than no cost table.
      expect((result as unknown as { value: string }).value).toBe("classified");
    } finally {
      db = real;
      consoleError.mockRestore();
    }
  });

  it("recordAiUsage itself never throws", async () => {
    const real = db;
    db = { insert: () => { throw new Error("nope"); } } as unknown as Database;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      recordAiUsage({
        operation: "x",
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        latencyMs: 1,
        success: true,
        attempt: 1,
        environment: "test",
      })
    ).resolves.toBeUndefined();

    db = real;
    consoleError.mockRestore();
  });
});

describe("attribution", () => {
  it("an unattributed call is recorded as such, not hidden", async () => {
    // A call with no tenant is a real finding — some path spends money nobody
    // is accountable for — and it has to stay findable.
    await withAiOperation("requirement.parse_semantics", () =>
      runThroughMiddleware(async () => ({ usage: usage(1, 1) }))
    );

    const [row] = await rows();
    expect(row.organizationId).toBeNull();
  });

  it("a call outside any declared operation is labelled, never silently dropped", async () => {
    await runThroughMiddleware(async () => ({ usage: usage(1, 1) }));

    const [row] = await rows();
    expect(row.operation).toBe("unattributed");
  });

  it("an inner scope adds detail without discarding the tenant", async () => {
    await withAiContext({ organizationId: orgId }, () =>
      withAiOperation("conversation.resolve_reference", async () => {
        expect(getAiCallContext()?.organizationId).toBe(orgId);
        await runThroughMiddleware(async () => ({ usage: usage(1, 1) }));
      })
    );

    const [row] = await rows();
    expect(row.organizationId).toBe(orgId);
    expect(row.operation).toBe("conversation.resolve_reference");
  });

  it("an undefined field does not erase an inherited one", async () => {
    await withAiContext({ organizationId: orgId }, () =>
      withAiContext({ organizationId: undefined }, async () => {
        expect(getAiCallContext()?.organizationId, "still the outer tenant").toBe(orgId);
      })
    );
  });

  it("two tenants' calls never merge", async () => {
    const [other] = await db.insert(schema.organizations).values({ name: "אחר" }).returning();

    await withAiContext({ organizationId: orgId }, () =>
      withAiOperation("a", () => runThroughMiddleware(async () => ({ usage: usage(100, 10) })))
    );
    await withAiContext({ organizationId: other.id }, () =>
      withAiOperation("b", () => runThroughMiddleware(async () => ({ usage: usage(200, 20) })))
    );

    const mine = (await rows()).filter((r) => r.organizationId === orgId);
    expect(mine).toHaveLength(1);
    expect(mine[0].inputTokens).toBe(100);
  });

  it("concurrent calls do not leak each other's tenant", async () => {
    const [other] = await db.insert(schema.organizations).values({ name: "אחר" }).returning();

    await Promise.all([
      withAiContext({ organizationId: orgId }, () =>
        withAiOperation("a", () => runThroughMiddleware(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { usage: usage(1, 1) };
        }))
      ),
      withAiContext({ organizationId: other.id }, () =>
        withAiOperation("b", () => runThroughMiddleware(async () => ({ usage: usage(2, 2) })))
      ),
    ]);

    const recorded = await rows();
    expect(recorded.find((r) => r.operation === "a")?.organizationId).toBe(orgId);
    expect(recorded.find((r) => r.operation === "b")?.organizationId).toBe(other.id);
  });
});

describe("no secrets, ever", () => {
  it("an error kind is a class name, never a message", () => {
    expect(classifyErrorKind(new TypeError("sk-ant-api03-SECRET leaked here"))).toBe("TypeError");
    expect(classifyErrorKind("plain string")).toBe("UnknownError");
  });

  it("the recorded row has no field that could hold a prompt or a key", async () => {
    await withAiOperation("document.vision_classify", () =>
      runThroughMiddleware(async () => ({ usage: usage(1, 1) }))
    );

    const [row] = await rows();
    // Every column is an identifier, a count, or a label. If a future change
    // adds somewhere for content to live, this fails.
    expect(Object.keys(row).sort()).toEqual(
      [
        "attempt",
        "cacheWriteTokens",
        "cachedInputTokens",
        "collectionRequestId",
        "conversationId",
        "createdAt",
        "documentId",
        "environment",
        "errorKind",
        "id",
        "inputTokens",
        "latencyMs",
        "modelId",
        "operation",
        "organizationId",
        "outputTokens",
        "provider",
        "reasoningTokens",
        "success",
        "totalTokens",
      ].sort()
    );
  });

  it("reports which deployment spent the money", () => {
    expect(currentEnvironment()).toBeTruthy();
  });
});

describe("organization deletion", () => {
  it("keeps the usage row rather than erasing what it cost", async () => {
    await withAiContext({ organizationId: orgId }, () =>
      withAiOperation("a", () => runThroughMiddleware(async () => ({ usage: usage(5, 5) })))
    );

    await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));

    const recorded = await rows();
    expect(recorded, "history survives").toHaveLength(1);
    expect(recorded[0].organizationId, "but is no longer attributed").toBeNull();
    expect(recorded[0].inputTokens).toBe(5);
  });
});
