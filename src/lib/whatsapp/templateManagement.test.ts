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

  it("carries the exact requested wording, and is UTILITY/Hebrew", () => {
    const request = findManagedTemplate("centro_document_request_v3")!;
    expect(request.bodyText).toBe("שלום, לצורך המשך הטיפול נשמח לקבל את המסמכים הבאים:\n{{1}}");
    const reminder = findManagedTemplate("centro_document_reminder_v3")!;
    expect(reminder.bodyText).toBe(
      "שלום, זוהי תזכורת בנוגע למסמכים שעדיין חסרים להמשך הטיפול:\n{{1}}"
    );
    for (const template of MANAGED_TEMPLATES) {
      expect(template.category).toBe("UTILITY");
      expect(template.language).toBe("he");
    }
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
