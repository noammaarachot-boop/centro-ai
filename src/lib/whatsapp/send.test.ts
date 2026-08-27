import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("sendTemplateMessage — Meta error responses never leak request content into the thrown error", () => {
  it("reduces a JSON error body down to code/message, never the raw body (which can echo recipient/template params)", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            message: "Invalid parameter",
            code: 100,
            error_subcode: 2494010,
            type: "OAuthException",
            fbtrace_id: "AbCdEfGhIjK",
          },
        }),
    });
    await expect(
      sendTemplateMessage("phone-1", "972500000000", "centro_document_request_v3", "he", ["תעודת זהות, אישור שכירות"])
      // Subcode, type and fbtrace_id are now carried too: code 100 alone
      // cannot distinguish "template not on this WABA" from "this token
      // cannot see this account" (100/33), and fbtrace_id is the only
      // reference Meta support can act on. All are structured error fields,
      // never echoed request content.
    ).rejects.toThrow(/code=100 subcode=2494010 type=OAuthException fbtrace_id=AbCdEfGhIjK message=Invalid parameter/);
  });

  it("never includes the sensitive recipient/params echo Meta's error body can contain", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: { message: "Invalid parameter", code: 100 },
          // Realistic shape of what Meta can echo back — must never leak.
          echoed_recipient: "972500000000",
        }),
    });
    await expect(
      sendTemplateMessage("phone-1", "972500000000", "centro_initial_request_v2", "he", ["תעודת זהות, אישור שכירות"])
    ).rejects.not.toThrow(/echoed_recipient/);
  });
});

describe("sendTemplateMessage — Phase 3.2: retries only the statuses actually worth retrying", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a 429 and succeeds on the second attempt", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers(), text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.retried" }] }) });

    const promise = sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ messageId: "wamid.retried" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 500 and succeeds on a later attempt", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, headers: new Headers(), text: async () => "" })
      .mockResolvedValueOnce({ ok: false, status: 503, headers: new Headers(), text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.retried" }] }) });

    const promise = sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).resolves.toEqual({ messageId: "wamid.retried" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honors Meta's own Retry-After header instead of the default exponential backoff", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429, headers: new Headers({ "retry-after": "5" }), text: async () => "" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ id: "wamid.retried" }] }) });

    const promise = sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // still waiting on the 5s Retry-After, not the ~200ms default backoff

    await vi.advanceTimersByTimeAsync(1_500);
    await expect(promise).resolves.toEqual({ messageId: "wamid.retried" });
  });

  it("a non-retryable 4xx (e.g. invalid recipient) fails immediately — never retried, never delayed", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Invalid recipient", code: 131026 } }),
    });

    await expect(sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he")).rejects.toThrow(/code=131026/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after retries are exhausted on a persistent 5xx, still surfacing the real Meta error", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Internal error", code: 1 } }),
    });

    const promise = sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    const assertion = expect(promise).rejects.toThrow(/code=1 message=Internal error/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // withRetry's default 3 attempts
  });
});

describe("sendTemplateMessage — Phase 3.3: every Meta call carries a request timeout", () => {
  it("wires an AbortSignal into the fetch call so a hung request fails fast instead of consuming the whole function budget", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.test" }] }) });
    await sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// Manual per-organization WhatsApp connection — proves the org-specific
// token, when passed, is what actually authorizes the Graph API call
// instead of the shared system token, and that every existing caller
// (which never passes a fifth argument) keeps using the shared token
// exactly as before this feature existed.
describe("sendTemplateMessage — per-organization Access Token", () => {
  it("uses the organization's own access token when one is provided, not WHATSAPP_SYSTEM_USER_TOKEN", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.test" }] }) });
    await sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he", [], "org-own-token");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer org-own-token");
  });

  it("falls back to WHATSAPP_SYSTEM_USER_TOKEN when no organization token is passed (existing Embedded Signup connections, unchanged)", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ messages: [{ id: "wamid.test" }] }) });
    await sendTemplateMessage("phone-1", "972500000000", "centro_initial_request", "he");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer fake-token");
  });
});
