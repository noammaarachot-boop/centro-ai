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

const { getFirstPhoneNumberForWaba, WhatsAppApiError } = await import("./phoneNumbers");

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
