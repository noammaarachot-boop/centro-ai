import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "fake-system-token" }),
  GRAPH_API_BASE: "https://graph.example/v1",
}));

const {
  MANAGED_TEMPLATES,
  DEFAULT_DOCUMENT_LIST_EXAMPLE,
  describeRejectionReason,
  editTemplateInMeta,
  fetchTemplateStatuses,
  findManagedTemplate,
  isPlaceholderPositionValid,
  resolveEditEligibility,
  submitTemplateToMeta,
  validateExampleValue,
  WhatsAppTemplateSubmissionError,
} = await import("./templateManagement");

// Owner-managed, per-organization WhatsApp templates: composed here,
// submitted to ONE organization's own WABA with ITS OWN token, and tracked
// through Meta's review. Deliberately independent of templates.ts's
// shared-token provisioning, which is left untouched.

describe("MANAGED_TEMPLATES — the two owner-managed templates", () => {
  it("uses brand-new names, so none of the pre-existing templates are affected", () => {
    const names = MANAGED_TEMPLATES.map((t) => t.name);
    expect(names).toEqual(["centro_document_request_v3", "centro_document_reminder_v3"]);
    expect(names).not.toContain("centro_initial_request_v2");
    expect(names).not.toContain("centro_reminder_v2");
  });

  it("both carry exactly one POSITIONAL {{1}} placeholder — never a named one, never a second variable", () => {
    for (const template of MANAGED_TEMPLATES) {
      expect(template.bodyText).toContain("{{1}}");
      expect(template.bodyText).not.toContain("{{2}}");
      // A named placeholder like {{documents}} would be a different
      // submission shape entirely.
      expect(template.bodyText).not.toMatch(/\{\{[a-zA-Z_]+\}\}/);
    }
  });

  it("carries the requested wording, and is UTILITY/Hebrew", () => {
    const request = findManagedTemplate("centro_document_request_v3")!;
    expect(request.bodyText).toContain("היי! 👋");
    expect(request.bodyText).toContain("אני העוזר הדיגיטלי של המשרד.");
    expect(request.bodyText).toContain("נא לשלוח את המסמכים הבאים:");
    expect(request.bodyText).toContain("נעדכן אותך באופן אוטומטי אילו מסמכים התקבלו ואילו עדיין חסרים.");

    const reminder = findManagedTemplate("centro_document_reminder_v3")!;
    expect(reminder.bodyText).toContain("רצינו להזכיר שעדיין חסרים המסמכים הבאים:");
    expect(reminder.bodyText).toContain("לאחר קבלת כל המסמכים הנדרשים, הבקשה תושלם באופן אוטומטי.");

    for (const template of MANAGED_TEMPLATES) {
      expect(template.category).toBe("UTILITY");
      expect(template.language).toBe("he");
      expect(template.purpose.length).toBeGreaterThan(0);
    }
  });

  // Regression guard for the live rejection: "אי אפשר למקם את המשתנים
  // בהתחלה או בסוף של התבנית" — Meta requires static text on BOTH sides of
  // a placeholder.
  it("neither template starts or ends with the placeholder — Meta rejects that outright", () => {
    for (const template of MANAGED_TEMPLATES) {
      expect(isPlaceholderPositionValid(template.bodyText)).toBe(true);
      expect(template.bodyText.trim().startsWith("{{1}}")).toBe(false);
      expect(template.bodyText.trim().endsWith("{{1}}")).toBe(false);
      // There is real static text after the placeholder, not just whitespace.
      expect(template.bodyText.split("{{1}}")[1].trim().length).toBeGreaterThan(0);
    }
  });
});

// Meta's real constraints, encoded so the screen can disable an action
// with an explanation instead of surfacing an API error after the fact.
describe("resolveEditEligibility", () => {
  const metaTemplateId = "meta-tpl-1";
  const now = new Date("2026-08-23T12:00:00Z");

  it("refuses to edit a template that was never submitted", () => {
    const result = resolveEditEligibility({ status: "LOCAL_DRAFT", metaTemplateId: null, lastEditedAt: null });
    expect(result.canEdit).toBe(false);
    expect(result.blockedReason).toMatch(/לא הוגשה/);
  });

  it("refuses while PENDING — Meta does not allow editing a template under review", () => {
    const result = resolveEditEligibility({ status: "PENDING", metaTemplateId, lastEditedAt: null });
    expect(result.canEdit).toBe(false);
    expect(result.blockedReason).toMatch(/בבדיקה/);
  });

  it("allows editing in each status Meta permits", () => {
    for (const status of ["APPROVED", "REJECTED", "PAUSED"]) {
      expect(resolveEditEligibility({ status, metaTemplateId, lastEditedAt: null }).canEdit).toBe(true);
    }
  });

  it("refuses a status Meta does not permit editing in", () => {
    const result = resolveEditEligibility({ status: "PENDING_DELETION", metaTemplateId, lastEditedAt: null });
    expect(result.canEdit).toBe(false);
  });

  it("enforces Meta's one-edit-per-24-hours limit, and explains when it lifts", () => {
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const result = resolveEditEligibility({
      status: "APPROVED",
      metaTemplateId,
      lastEditedAt: twoHoursAgo,
      now,
    });
    expect(result.canEdit).toBe(false);
    expect(result.blockedReason).toMatch(/24 שעות/);
  });

  it("allows editing again once the 24-hour window has passed", () => {
    const yesterday = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    expect(
      resolveEditEligibility({ status: "APPROVED", metaTemplateId, lastEditedAt: yesterday, now }).canEdit
    ).toBe(true);
  });
});

describe("isPlaceholderPositionValid", () => {
  it("rejects a body that starts or ends with the placeholder", () => {
    expect(isPlaceholderPositionValid("{{1}} ואז טקסט")).toBe(false);
    expect(isPlaceholderPositionValid("טקסט ואז {{1}}")).toBe(false);
    // Trailing whitespace/newline is not "static text" to Meta.
    expect(isPlaceholderPositionValid("טקסט ואז {{1}}\n")).toBe(false);
  });

  it("accepts a body with real static text on both sides", () => {
    expect(isPlaceholderPositionValid("לפני\n{{1}}\nאחרי")).toBe(true);
  });
});

describe("validateExampleValue — catches what Meta would reject, before submitting", () => {
  it("accepts a normal comma-separated document list", () => {
    expect(validateExampleValue(DEFAULT_DOCUMENT_LIST_EXAMPLE)).toBeNull();
  });

  it("rejects an empty example — Meta fails a parameterized template outright without one", () => {
    expect(validateExampleValue("")).toMatch(/דוגמה/);
    expect(validateExampleValue("   ")).toMatch(/דוגמה/);
  });

  it("rejects a newline inside the example — Meta forbids newlines in a parameter value", () => {
    expect(validateExampleValue("תעודת זהות\nתלוש שכר")).toMatch(/ירידת שורה/);
  });
});

describe("submitTemplateToMeta", () => {
  it("POSTs to the organization's OWN WABA with its OWN token, in Meta's documented shape", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "meta-tpl-1", status: "PENDING", category: "UTILITY" }),
    });

    const result = await submitTemplateToMeta({
      wabaId: "waba-1",
      accessToken: "org-own-token",
      name: "centro_document_request_v3",
      language: "he",
      category: "UTILITY",
      bodyText: "שלום:\n{{1}}",
      exampleValues: ["תעודת זהות, תלוש שכר"],
    });

    expect(result).toEqual({ metaTemplateId: "meta-tpl-1", status: "PENDING", category: "UTILITY" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://graph.example/v1/waba-1/message_templates");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer org-own-token"); // never the shared system token
    const body = JSON.parse(init.body);
    expect(body.name).toBe("centro_document_request_v3");
    // Meta's positional shape: an array of example SETS, one value per {{n}}.
    expect(body.components[0].example).toEqual({ body_text: [["תעודת זהות, תלוש שכר"]] });
  });

  it("surfaces Meta's own error message on rejection, so the owner sees the real reason", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "Template name already exists" } }),
    });

    await expect(
      submitTemplateToMeta({
        wabaId: "waba-1",
        accessToken: "t",
        name: "n",
        language: "he",
        category: "UTILITY",
        bodyText: "{{1}}",
        exampleValues: ["x"],
      })
    ).rejects.toThrow(/Template name already exists/);
  });

  // Without these fields every permission failure looks identical, and an
  // app-level permission problem is indistinguishable from an asset-level
  // one — which is exactly what blocked diagnosing the live rejection.
  it("keeps Meta's full diagnostic detail: status, code, error_subcode, type and fbtrace_id", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () =>
        JSON.stringify({
          error: {
            message: "(#200) Permissions error",
            error_user_msg: "אין הרשאה ליצור תבניות",
            code: 200,
            error_subcode: 2388093,
            type: "OAuthException",
            fbtrace_id: "AbCdEf123",
          },
        }),
    });

    let caught: unknown;
    try {
      await submitTemplateToMeta({
        wabaId: "waba-1",
        accessToken: "super-secret-token",
        name: "n",
        language: "he",
        category: "UTILITY",
        bodyText: "{{1}}",
        exampleValues: ["x"],
      });
    } catch (error) {
      caught = error;
    }

    const message = (caught as Error).message;
    expect(message).toContain("אין הרשאה ליצור תבניות");
    expect(message).toContain("HTTP 403");
    expect(message).toContain("code 200");
    expect(message).toContain("subcode 2388093");
    expect(message).toContain("OAuthException");
    expect(message).toContain("AbCdEf123");
    // The token is never part of Meta's error, and must never be added to it.
    expect(message).not.toContain("super-secret-token");
  });

  it("throws rather than silently succeeding when Meta returns no template id", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ status: "PENDING" }) });

    await expect(
      submitTemplateToMeta({
        wabaId: "waba-1",
        accessToken: "t",
        name: "n",
        language: "he",
        category: "UTILITY",
        bodyText: "{{1}}",
        exampleValues: ["x"],
      })
    ).rejects.toBeInstanceOf(WhatsAppTemplateSubmissionError);
  });
});

describe("editTemplateInMeta — the only correct way to resubmit a rejected template", () => {
  it("POSTs to the template's own node, not a second create under the same name", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });

    await editTemplateInMeta({
      metaTemplateId: "meta-tpl-1",
      accessToken: "org-own-token",
      category: "UTILITY",
      bodyText: "שלום:\n{{1}}",
      exampleValues: ["תעודת זהות"],
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://graph.example/v1/meta-tpl-1");
    expect(init.method).toBe("POST");
    // A create would have gone to /{waba-id}/message_templates — Meta
    // refuses that for a name it already holds.
    expect(String(url)).not.toContain("message_templates");
    expect(JSON.parse(init.body).components[0].example).toEqual({ body_text: [["תעודת זהות"]] });
  });
});

describe("fetchTemplateStatuses", () => {
  it("reads status/category/rejected_reason from the organization's own WABA", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "meta-tpl-1",
            name: "centro_document_request_v3",
            language: "he",
            status: "APPROVED",
            category: "UTILITY",
            rejected_reason: "NONE",
          },
          {
            id: "meta-tpl-2",
            name: "centro_document_reminder_v3",
            language: "he",
            status: "REJECTED",
            category: "UTILITY",
            rejected_reason: "INVALID_FORMAT",
          },
        ],
      }),
    });

    const statuses = await fetchTemplateStatuses("waba-1", "org-own-token");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/waba-1/message_templates");
    expect(init.headers.Authorization).toBe("Bearer org-own-token");

    // "NONE" is Meta's way of saying "not rejected" — normalized away so a
    // caller never stores a meaningless reason next to an APPROVED status.
    expect(statuses[0].rejectedReason).toBeNull();
    expect(statuses[0].status).toBe("APPROVED");
    expect(statuses[1].rejectedReason).toBe("INVALID_FORMAT");
  });

  it("returns an empty list (not a crash) for a WABA with no templates yet", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await expect(fetchTemplateStatuses("waba-1", "t")).resolves.toEqual([]);
  });
});

describe("describeRejectionReason", () => {
  it("explains Meta's terse code in Hebrew", () => {
    expect(describeRejectionReason("INVALID_FORMAT")).toMatch(/דוגמה/);
  });

  it("falls through to the raw code rather than hiding a reason it doesn't recognize", () => {
    expect(describeRejectionReason("SOME_NEW_META_CODE")).toBe("SOME_NEW_META_CODE");
  });

  it("returns null when there is no rejection", () => {
    expect(describeRejectionReason(null)).toBeNull();
  });
});
