import { describe, expect, it } from "vitest";
import { buildInitialRequestSend } from "./initialRequestMessage";
import {
  INITIAL_REQUEST_BODY,
  INITIAL_REQUEST_V2_ENABLED,
  INITIAL_REQUEST_V2_TEMPLATE_NAME,
} from "./templates";

describe("buildInitialRequestSend — v2 approved and live (current production state)", () => {
  it("the shipped flag is true (centro_initial_request_v2 approved by Meta 2026-08-05)", () => {
    expect(INITIAL_REQUEST_V2_ENABLED).toBe(true);
  });

  it("defaults to v2 with no explicit flag argument, using the real production flag", () => {
    const send = buildInitialRequestSend(["תעודת זהות", "דפי חשבון בנק"]);
    expect(send.usedV2).toBe(true);
    expect(send.templateName).toBe(INITIAL_REQUEST_V2_TEMPLATE_NAME);
  });

  it("still falls back to the static v1 template when explicitly disabled", () => {
    const send = buildInitialRequestSend(["תעודת זהות", "דפי חשבון בנק"], false);
    expect(send.usedV2).toBe(false);
    expect(send.templateName).toBe("centro_initial_request");
    expect(send.params).toEqual([]);
    expect(send.renderedBody).toBe(INITIAL_REQUEST_BODY);
  });
});

describe("buildInitialRequestSend — v2 enabled", () => {
  it("uses the v2 template with the dynamic comma-separated document list as {{1}}", () => {
    const names = ["תעודת זהות", "דפי חשבון בנק", "דו״ח תיק השקעות"];
    const send = buildInitialRequestSend(names, true);
    expect(send.usedV2).toBe(true);
    expect(send.templateName).toBe(INITIAL_REQUEST_V2_TEMPLATE_NAME);
    expect(send.params).toEqual(["תעודת זהות, דפי חשבון בנק, דו״ח תיק השקעות"]);
  });

  it("renders the body with the list substituted into {{1}} (what the client sees)", () => {
    const send = buildInitialRequestSend(["רישיון עסק", "חוזה שכירות"], true);
    expect(send.renderedBody).toContain("רישיון עסק, חוזה שכירות");
    expect(send.renderedBody).not.toContain("{{1}}");
  });

  it("builds each org's message from its own list — no hardcoded documents", () => {
    const a = buildInitialRequestSend(["מסמך A1", "מסמך A2"], true);
    const b = buildInitialRequestSend(["מסמך B1"], true);
    expect(a.params).toEqual(["מסמך A1, מסמך A2"]);
    expect(b.params).toEqual(["מסמך B1"]);
  });

  it("falls back to the static template when the request has no requirements", () => {
    const send = buildInitialRequestSend([], true);
    expect(send.usedV2).toBe(false);
    expect(send.templateName).toBe("centro_initial_request");
    expect(send.params).toEqual([]);
  });

  it("the v2 parameter never contains a newline (Meta constraint)", () => {
    const send = buildInitialRequestSend(["א", "ב", "ג", "ד"], true);
    expect(send.params[0]).not.toMatch(/[\n\t]/);
  });
});
