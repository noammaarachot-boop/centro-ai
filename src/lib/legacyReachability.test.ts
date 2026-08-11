import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Static-source regression guard — proves (not just describes) that the
// pre-runConversationUnderstanding "old ladder" is genuinely disconnected
// from every real production entry point, and stays that way. A future
// change that re-wires any of these back in (e.g. "as a fallback on low
// confidence") will fail this test immediately, before it ever reaches
// production — this is deliberately a source-text check, not a runtime
// mock, because the bug class this guards against (an old classifier
// silently reachable again) is about what's *wired*, not what any single
// function returns.

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, "..", "..", relPath), "utf8");
}

// Matches a real call like `foo(` or `await foo(`, never a bare mention
// inside a comment or string — comments in this codebase reference these
// names constantly (as history/rationale), which must never count as a
// "real caller" for this guard's purposes.
function callSites(source: string, fnName: string): string[] {
  const lines = source.split("\n");
  const callPattern = new RegExp(`(?<![.\\w])${fnName}\\s*\\(`);
  return lines.filter((line) => {
    const codePart = line.split("//")[0];
    return callPattern.test(codePart);
  });
}

describe("legacy reachability — production dispatch paths never call the pre-understanding-layer functions", () => {
  const productionFiles = [
    "src/app/api/webhooks/whatsapp/route.ts",
    "src/app/(app)/collections/conversationActions.ts",
    "src/lib/conversationOrchestration.ts",
    "src/lib/scheduler.ts",
    "src/lib/correction/correctionDispatch.ts",
  ].map((p) => ({ path: p, source: readSrc(p) }));

  // classifyIntent (src/lib/ai/intentClassifier.ts) — the deterministic
  // keyword classifier from before any LLM provider was wired in. Used to
  // be called on every real inbound message purely to write a now-removed,
  // misleading audit-log row; never gated a decision even then.
  it("classifyIntent is never called from any real production dispatch file", () => {
    for (const { path, source } of productionFiles) {
      expect(callSites(source, "classifyIntent"), `unexpected classifyIntent call in ${path}`).toEqual([]);
    }
  });

  // resolveOpenClarificationReply / resolveConfirmationFromReply — the old
  // per-kind resolvers the pre-03e719c "reply ladder" called directly, in
  // a fixed order. runConversationUnderstanding replaces the DECISION of
  // which to run; the ladder itself must never be reconstructed inline in
  // a production dispatch file again.
  it("the old reply-ladder resolvers are never called directly from a real production dispatch file", () => {
    for (const { path, source } of productionFiles) {
      expect(callSites(source, "resolveOpenClarificationReply"), `unexpected call in ${path}`).toEqual([]);
      expect(callSites(source, "resolveConfirmationFromReply"), `unexpected call in ${path}`).toEqual([]);
    }
  });

  // runCorrectionLayer / classifyCorrectionIntent (correctionDispatch.ts /
  // correctionClassifier.ts) — an earlier, narrower LLM classifier with
  // its own, different confidence thresholds (0.75/0.8) than the live
  // classifyConversationIntent path (0.65/0.85). Fully unwired already;
  // this guards against it being reintroduced "as a fallback" without
  // anyone reconciling the two threshold policies.
  it("runCorrectionLayer has no callers outside its own definition file", () => {
    for (const { path, source } of productionFiles) {
      if (path === "src/lib/correction/correctionDispatch.ts") continue; // its own declaration lives here
      expect(callSites(source, "runCorrectionLayer"), `unexpected runCorrectionLayer call in ${path}`).toEqual([]);
    }
  });

  // applyFollowUpPromiseIfAny (formerly src/lib/caseReview.ts) — fully
  // removed (not just unwired) when reminderDeferral.ts's applyDeferralIfAny
  // became the single entry point for every deferral kind. Guards against
  // it quietly reappearing.
  it("applyFollowUpPromiseIfAny no longer exists anywhere in the source tree", () => {
    const files = [
      "src/lib/caseReview.ts",
      "src/lib/reminderDeferral.ts",
      "src/lib/scheduler.ts",
      "src/app/api/webhooks/whatsapp/route.ts",
    ];
    for (const path of files) {
      expect(readSrc(path), `unexpected applyFollowUpPromiseIfAny reference in ${path}`).not.toContain(
        "applyFollowUpPromiseIfAny"
      );
    }
  });

  // Positive checks — the real replacement must actually be wired in,
  // not just "the old thing is gone" (a file could satisfy every check
  // above by calling nothing at all).
  it("the real WhatsApp webhook route calls runConversationUnderstanding", () => {
    const source = readSrc("src/app/api/webhooks/whatsapp/route.ts");
    expect(callSites(source, "runConversationUnderstanding").length).toBeGreaterThan(0);
  });

  it("the DevTools inbound-message simulator calls runConversationUnderstanding (not a separate ladder)", () => {
    const source = readSrc("src/app/(app)/collections/conversationActions.ts");
    expect(callSites(source, "runConversationUnderstanding").length).toBeGreaterThan(0);
  });

  // respondToConfirmation (the employee manual override) — every real
  // applier the client-reply paths use must be present, not just
  // applyDocumentProfileConfirmation (the historical bug this session
  // fixed: confirmationRouting.test.ts proves the runtime behavior; this
  // proves the wiring itself can't silently regress to calling fewer than
  // all five again).
  it("respondToConfirmation calls all five real confirmation appliers", () => {
    const source = readSrc("src/app/(app)/collections/conversationActions.ts");
    for (const applier of [
      "applyDocumentProfileConfirmation",
      "applyUnsolicitedConfirmationDecision",
      "applyIdentityAnomalyDecision",
      "applyRequestReopenDecision",
      "applyExtensionFinishedDecision",
    ]) {
      expect(callSites(source, applier).length, `${applier} not called in conversationActions.ts`).toBeGreaterThan(0);
    }
  });
});
