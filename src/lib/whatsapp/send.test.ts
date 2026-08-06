import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendTemplateMessage } from "./send";

// centro_reminder_v2 uses a NAMED {{documents}} placeholder, not a
// positional {{1}} — this locks in the exact Cloud API request shape for
// both parameter styles so a future change can't silently break the
// mapping Meta actually approved.

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ messages: [{ id: "wamid.test" }] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

vi.mock("./config", () => ({
  getWhatsAppConfig: () => ({ systemUserToken: "fake-token" }),
  GRAPH_API_BASE: "https://graph.example/v1",
  GRAPH_API_VERSION: "v1",
}));

function lastRequestBody(): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body as string);
}

describe("sendTemplateMessage — positional parameters (e.g. centro_initial_request_v2)", () => {
  it("sends a plain array of {type, text}, no parameter_name field", async () => {
    await sendTemplateMessage("phone-1", "972500000000", "centro_initial_request_v2", "he", ["תעודת זהות, אישור שכירות"]);
    const body = lastRequestBody();
    expect(body.template).toEqual({
      name: "centro_initial_request_v2",
      language: { code: "he" },
      components: [{ type: "body", parameters: [{ type: "text", text: "תעודת זהות, אישור שכירות" }] }],
    });
  });
});

describe("sendTemplateMessage — named parameters (centro_reminder_v2's {{documents}})", () => {
  it("sends parameter_name matching the template's own placeholder name, exactly as approved", async () => {
    await sendTemplateMessage("phone-1", "972500000000", "centro_reminder_v2", "he", [
      { name: "documents", value: "תעודת זהות, 3 תלושי שכר, דפי בנק" },
    ]);
    const body = lastRequestBody();
    expect(body.template).toEqual({
      name: "centro_reminder_v2",
      language: { code: "he" },
      components: [
        {
          type: "body",
          parameters: [{ type: "text", parameter_name: "documents", text: "תעודת זהות, 3 תלושי שכר, דפי בנק" }],
        },
      ],
    });
  });
});

describe("sendTemplateMessage — no parameters", () => {
  it("omits the components field entirely for a zero-param template", async () => {
    await sendTemplateMessage("phone-1", "972500000000", "centro_reminder", "he");
    const body = lastRequestBody();
    expect(body.template).toEqual({ name: "centro_reminder", language: { code: "he" } });
  });
});
