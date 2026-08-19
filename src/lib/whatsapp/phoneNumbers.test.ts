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

const { getFirstPhoneNumberForWaba, getPhoneNumberInWaba, WhatsAppApiError } = await import("./phoneNumbers");

describe("getFirstPhoneNumberForWaba — single phone number (the common case)", () => {
  it("resolves the one phone number found on the WABA", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "phone-1", display_phone_number: "+972500000000", verified_name: "Office" }] }),
    });
    const result = await getFirstPhoneNumberForWaba("waba-1");
    expect(result).toEqual({ id: "phone-1", displayPhoneNumber: "+972500000000", verifiedName: "Office" });
  });
});

describe("getFirstPhoneNumberForWaba — Phase 2.2: never silently picks among several phone numbers", () => {
  it("throws a clear WhatsAppApiError instead of connecting to numbers[0] when the WABA has more than one number", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "phone-1", display_phone_number: "+972500000000", verified_name: "Office A" },
          { id: "phone-2", display_phone_number: "+972500000001", verified_name: "Office A — second line" },
        ],
      }),
    });
    await expect(getFirstPhoneNumberForWaba("waba-1")).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(getFirstPhoneNumberForWaba("waba-1")).rejects.toThrow(/2 phone numbers/);
  });

  it("still throws (not connect) when zero phone numbers are found", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    await expect(getFirstPhoneNumberForWaba("waba-1")).rejects.toBeInstanceOf(WhatsAppApiError);
  });
});

describe("getFirstPhoneNumberForWaba — Phase 7: request timeout", () => {
  it("wires an AbortSignal into the fetch call so a hung request fails fast", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "phone-1", display_phone_number: "+972500000000", verified_name: "Office" }] }),
    });
    await getFirstPhoneNumberForWaba("waba-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// Manual per-organization WhatsApp connection ("בדוק וחבר") — proves the
// real verification behavior the owner's "check & connect" button relies
// on: the given token must genuinely have access to the WABA, and the
// given phone number must genuinely belong to it. Deliberately never
// falls back to a system token — this function only ever uses the exact
// token it was handed.
describe("getPhoneNumberInWaba — verifies a specific token/WABA/phone number combination", () => {
  it("resolves the real display name/number when the phone number genuinely belongs to the WABA", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { id: "phone-1", display_phone_number: "+972500000000", verified_name: "Office A" },
          { id: "phone-2", display_phone_number: "+972500000001", verified_name: "Office A — second line" },
        ],
      }),
    });
    const result = await getPhoneNumberInWaba("waba-1", "phone-2", "owner-typed-token");
    expect(result).toEqual({ id: "phone-2", displayPhoneNumber: "+972500000001", verifiedName: "Office A — second line" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer owner-typed-token");
  });

  it("throws a clear error when the phone number id doesn't belong to this WABA at all", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "phone-1", display_phone_number: "+972500000000", verified_name: "Office A" }] }),
    });
    await expect(getPhoneNumberInWaba("waba-1", "phone-does-not-exist", "token")).rejects.toBeInstanceOf(WhatsAppApiError);
    await expect(getPhoneNumberInWaba("waba-1", "phone-does-not-exist", "token")).rejects.toThrow(/לא נמצא/);
  });

  it("throws a clear, specific error on 401/403 (invalid token or no permission on this WABA) — never echoes the token", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    await expect(getPhoneNumberInWaba("waba-1", "phone-1", "bad-token")).rejects.toThrow(/אינו תקף|הרשאה/);

    let caught: unknown;
    try {
      await getPhoneNumberInWaba("waba-1", "phone-1", "bad-token");
    } catch (error) {
      caught = error;
    }
    expect(String((caught as Error).message)).not.toContain("bad-token");
  });

  it("throws on other Graph API failures too, without ever falling back to a different token", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "internal error" });
    await expect(getPhoneNumberInWaba("waba-1", "phone-1", "token")).rejects.toBeInstanceOf(WhatsAppApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry-with-system-token fallback attempt
  });
});
