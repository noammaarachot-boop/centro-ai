import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "fake-token" }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const {
  LEAD_WELCOME_TEMPLATE,
  REQUIRED_TEMPLATES,
  TEMPLATE_BY_BODY,
  ensureTemplatesProvisioned,
} = await import("./templates");

describe("TEMPLATE_BY_BODY", () => {
  it("has one entry per required template, keyed by its exact body text", () => {
    expect(TEMPLATE_BY_BODY.size).toBe(REQUIRED_TEMPLATES.length);
    for (const template of REQUIRED_TEMPLATES) {
      expect(TEMPLATE_BY_BODY.get(template.bodyText)).toBe(template);
    }
  });
});

describe("template definitions", () => {
  it("every template name is unique", () => {
    const allTemplates = [...REQUIRED_TEMPLATES, LEAD_WELCOME_TEMPLATE];
    const names = allTemplates.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Regression test for the live INVALID_FORMAT rejection found while
  // building M-WA-5: Meta rejects submission outright for any template
  // whose body contains a {{n}} placeholder without a matching
  // exampleParams entry.
  it("every template with a {{n}} placeholder declares exampleParams", () => {
    const allTemplates = [...REQUIRED_TEMPLATES, LEAD_WELCOME_TEMPLATE];
    for (const template of allTemplates) {
      const placeholderCount = (template.bodyText.match(/\{\{\d+\}\}/g) ?? []).length;
      if (placeholderCount > 0) {
        expect(template.exampleParams?.length ?? 0).toBeGreaterThanOrEqual(placeholderCount);
      }
    }
  });

  // The live send path's TEMPLATE_BY_BODY exact-body lookup
  // (conversationOrchestration.ts's sendViaWhatsApp) resolves templates with
  // zero body parameters, so any template found that way must have no
  // {{n}} placeholder. The parameterized centro_initial_request_v2 is the
  // one exception — it carries exampleParams and is always sent through the
  // explicit templateSend descriptor built by buildInitialRequestSend,
  // never through this zero-param body lookup.
  it("any template without exampleParams or namedExampleParams has no placeholder at all (safe to send with zero params)", () => {
    for (const template of REQUIRED_TEMPLATES) {
      if (!template.exampleParams && !template.namedExampleParams) {
        expect(template.bodyText).not.toMatch(/\{\{[\w\d]+\}\}/);
      }
    }
  });

  // The named-parameter equivalent of the positional check above —
  // centro_reminder_v2's {{documents}} isn't a {{n}} positional
  // placeholder, so it needs its own regex and its own declared example
  // shape (namedExampleParams, matched to Meta's body_text_named_params
  // submission format).
  it("every template with a {{word}} named placeholder declares namedExampleParams with a matching param name", () => {
    for (const template of REQUIRED_TEMPLATES) {
      const namedPlaceholders = [...template.bodyText.matchAll(/\{\{([a-zA-Z_][\w]*)\}\}/g)].map((m) => m[1]);
      if (namedPlaceholders.length === 0) continue;
      expect(template.namedExampleParams?.length ?? 0).toBeGreaterThanOrEqual(namedPlaceholders.length);
      for (const placeholder of namedPlaceholders) {
        expect(template.namedExampleParams?.some((p) => p.paramName === placeholder)).toBe(true);
      }
    }
  });
});

describe("ensureTemplatesProvisioned — Phase 7: request timeout", () => {
  it("wires an AbortSignal into both the list and the create Graph API calls", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("message_templates?")) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      return { ok: true, json: async () => ({ id: "template-1" }) };
    });

    await ensureTemplatesProvisioned("waba-1", [REQUIRED_TEMPLATES[0]]);

    expect(fetchMock).toHaveBeenCalledTimes(2); // list existing, then create the one missing template
    for (const call of fetchMock.mock.calls) {
      const [, init] = call;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
