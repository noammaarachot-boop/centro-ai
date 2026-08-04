import { describe, expect, it } from "vitest";
import { buildInitialRequestSend } from "./initialRequestMessage";
import {
  INITIAL_REQUEST_BODY,
  INITIAL_REQUEST_V2_ENABLED,
  INITIAL_REQUEST_V2_TEMPLATE_NAME,
} from "./templates";

describe("buildInitialRequestSend — while v2 is disabled (current production state)", () => {
  it("the shipped flag is still false (v2 not sent live until Meta approves)", () => {
    expect(INITIAL_REQUEST_V2_ENABLED).toBe(false);
  });

  it("falls back to the static v1 template with no params, even with a requirement list", () => {
    const send = buildInitialRequestSend(["תעודת זהות", "דפי חשבון בנק"], false);
    expect(send.usedV2).toBe(false);
    expect(send.templateName).toBe("centro_initial_request");
    expect(send.params).toEqual([]);
    expect(send.renderedBody).toBe(INITIAL_REQUEST_BODY);
  });
});

describe("buildInitialRequestSend — v2 enabled (Phase 2, once approved)", () => {
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
