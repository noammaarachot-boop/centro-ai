import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateObject } from "ai";
import { resolveLanguageModel } from "@/lib/aiCore/providers/resolveModel";
import { outcomeSchema } from "./conversationUnderstanding";

/**
 * Root-cause regression test (production incident, 2026-08-15) — a real,
 * UNMOCKED generateObject call against the real AI provider, using the
 * real outcomeSchema (not a hand-copied approximation of it). This is the
 * one kind of test that could have actually caught the incident: every
 * other test in this codebase mocks generateObject, which validates the
 * SHAPE a test hands back, never whether the real provider accepts the
 * schema itself. Before this fix, every one of these calls failed with:
 * "Schemas contains too many parameters with union types (17 parameters
 * with type arrays or anyOf) ... limit: 16 parameters with unions."
 *
 * Skips (not fails) when no AI provider is configured — e.g. CI without
 * secrets — since there is no local/mocked way to prove a real provider
 * accepts a schema; this file's whole purpose requires a real call.
 */

function hasAnyApiKey(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY) return true;
  // Local dev convention in this repo: `.env.local`, not auto-loaded by
  // vitest. Read it directly rather than requiring every invocation to
  // remember `--env-file` — same key names dotenv/Next would resolve.
  const envPath = ".env.local";
  if (!existsSync(envPath)) return false;
  const content = readFileSync(envPath, "utf8");
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
    const match = content.match(new RegExp(`^${key}=(.+)$`, "m"));
    if (match && match[1].trim()) {
      process.env[key] = match[1].trim();
      return true;
    }
  }
  return false;
}

const describeIfConfigured = hasAnyApiKey() ? describe : describe.skip;

describeIfConfigured("outcomeSchema — real structured generation against the real AI provider (not mocked)", () => {
  async function generate(instruction: string) {
    const model = await resolveLanguageModel();
    return generateObject({
      model,
      schema: outcomeSchema,
      messages: [{ role: "user", content: instruction }],
    });
  }

  it("UNRELATED", async () => {
    const { object } = await generate('Reply with outcome="UNRELATED".');
    expect(object.outcome).toBe("UNRELATED");
  }, 30_000);

  it("ANSWER", async () => {
    const { object } = await generate('Reply with outcome="ANSWER" and answerGroundedOn=["fact-1","fact-2"].');
    expect(object.outcome).toBe("ANSWER");
    if (object.outcome === "ANSWER") expect(Array.isArray(object.answerGroundedOn)).toBe(true);
  }, 30_000);

  it("CLARIFY", async () => {
    const { object } = await generate('Reply with outcome="CLARIFY", clarifyQuestion="test question", clarifyMissing="test missing".');
    expect(object.outcome).toBe("CLARIFY");
    if (object.outcome === "CLARIFY") {
      expect(typeof object.clarifyQuestion).toBe("string");
      expect(typeof object.clarifyMissing).toBe("string");
    }
  }, 30_000);

  it("ESCALATE", async () => {
    const { object } = await generate(
      'Reply with outcome="ESCALATE", escalateCategory="human_request", escalateGist="test gist".'
    );
    expect(object.outcome).toBe("ESCALATE");
    if (object.outcome === "ESCALATE") {
      expect(object.escalateCategory).toBe("human_request");
      expect(typeof object.escalateGist).toBe("string");
    }
  }, 30_000);

  it("ACT / resolve_pending", async () => {
    const { object } = await generate(
      'Reply with outcome="ACT", action.actionKind="resolve_pending", action.actionOpenQuestionId="q-1", action.actionAnswer="confirm".'
    );
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("resolve_pending");
  }, 30_000);

  it("ACT / resolve_clarification", async () => {
    const { object } = await generate(
      'Reply with outcome="ACT", action.actionKind="resolve_clarification", action.actionOpenQuestionId="q-1", action.actionReplyText="test reply".'
    );
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("resolve_clarification");
  }, 30_000);

  it("ACT / correct_resolved", async () => {
    const { object } = await generate(
      'Reply with outcome="ACT", action.actionKind="correct_resolved", action.actionTargetType="document", action.actionTargetId="doc-1", action.actionDesiredOutcome="mark_withdrawn".'
    );
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("correct_resolved");
  }, 30_000);

  it("ACT / report_missing_document (with actionMentionedType null — the one field still nullable)", async () => {
    const { object } = await generate(
      'Reply with outcome="ACT", action.actionKind="report_missing_document", action.actionMentionedType=null.'
    );
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("report_missing_document");
  }, 30_000);

  it("ACT / finish_request (no extra fields)", async () => {
    const { object } = await generate('Reply with outcome="ACT", action.actionKind="finish_request".');
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("finish_request");
  }, 30_000);

  it("ACT / defer", async () => {
    const { object } = await generate('Reply with outcome="ACT", action.actionKind="defer", action.actionReplyText="אשלח מחר".');
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("defer");
  }, 30_000);

  it("ACT / resolve_review_item (the deepest/widest branch — 4 required fields)", async () => {
    const { object } = await generate(
      'Reply with outcome="ACT", action.actionKind="resolve_review_item", action.actionReviewItemId="r-1", action.actionReviewAction="close_resolved", action.actionReviewReason="test reason", action.actionAcknowledgment="test ack".'
    );
    expect(object.outcome).toBe("ACT");
    if (object.outcome === "ACT") expect(object.action.actionKind).toBe("resolve_review_item");
  }, 30_000);
});
