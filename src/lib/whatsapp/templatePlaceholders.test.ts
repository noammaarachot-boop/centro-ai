import { describe, expect, it } from "vitest";
import {
  buildTemplateParams,
  readTemplatePlaceholders,
  renderTemplateBody,
  type ResolvedTemplate,
} from "./organizationWhatsApp";

/**
 * Regression — a template's parameter style is a property of the approved
 * body, not an assumption.
 *
 * The retired centro_reminder_v2 used a NAMED placeholder ({{documents}})
 * and the send path hardcoded a matching {name, value} pair. The approved
 * v3 templates use POSITIONAL {{1}}, which Meta requires be sent as bare
 * strings — a named pair against a positional body is rejected. Reading the
 * style off the body is what stops that pairing from ever going stale again.
 */

const template = (bodyText: string): ResolvedTemplate => ({
  intent: "DOCUMENT_REMINDER",
  name: "t",
  language: "he",
  metaTemplateId: null,
  status: "APPROVED",
  bodyText,
  placeholders: readTemplatePlaceholders(bodyText),
  wabaId: "waba-1",
});

describe("readTemplatePlaceholders", () => {
  it("recognises a positional body", () => {
    expect(readTemplatePlaceholders("חסרים: {{1}}. תודה.")).toEqual({
      style: "positional",
      names: [],
      count: 1,
    });
  });

  it("recognises a named body", () => {
    expect(readTemplatePlaceholders("חסרים: {{documents}}. תודה.")).toEqual({
      style: "named",
      names: ["documents"],
      count: 1,
    });
  });

  it("counts multiple positional placeholders without double-counting a repeat", () => {
    expect(readTemplatePlaceholders("{{1}} ואז {{2}} ושוב {{1}}.").count).toBe(2);
  });

  it("handles a body with no placeholders", () => {
    expect(readTemplatePlaceholders("תודה רבה.").style).toBe("none");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(readTemplatePlaceholders("חסרים: {{ documents }}.").names).toEqual(["documents"]);
  });
});

describe("buildTemplateParams", () => {
  it("a positional template gets bare strings", () => {
    expect(buildTemplateParams(template("חסרים: {{1}}."), ["תעודת זהות"])).toEqual(["תעודת זהות"]);
  });

  it("a named template gets {name, value} pairs", () => {
    expect(buildTemplateParams(template("חסרים: {{documents}}."), ["תעודת זהות"])).toEqual([
      { name: "documents", value: "תעודת זהות" },
    ]);
  });

  it("a template with no placeholders gets no parameters at all", () => {
    // Meta rejects a components array on a template that declares none.
    expect(buildTemplateParams(template("תודה."), ["ignored"])).toEqual([]);
  });

  it("never sends more parameters than the body declares", () => {
    expect(buildTemplateParams(template("{{1}}"), ["a", "b", "c"])).toEqual(["a"]);
  });
});

describe("renderTemplateBody", () => {
  it("fills a positional body in placeholder order", () => {
    expect(renderTemplateBody(template("שלום {{1}}, חסר {{2}}."), ["רז", "תעודת זהות"])).toBe(
      "שלום רז, חסר תעודת זהות."
    );
  });

  it("fills a named body by name", () => {
    expect(renderTemplateBody(template("חסרים: {{documents}}."), ["תעודת זהות"])).toBe(
      "חסרים: תעודת זהות."
    );
  });

  it("leaves a body with no placeholders untouched", () => {
    expect(renderTemplateBody(template("תודה."), [])).toBe("תודה.");
  });

  it("stores what the client actually receives, so the thread cannot drift from the approved text", () => {
    const body = renderTemplateBody(template("חסרים: {{1}}. תודה."), ["תעודת זהות, דפי בנק"]);
    expect(body).toBe("חסרים: תעודת זהות, דפי בנק. תודה.");
    expect(body).not.toContain("{{");
  });
});
