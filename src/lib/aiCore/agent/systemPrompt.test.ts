import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./systemPrompt";

describe("buildSystemPrompt", () => {
  it("identifies the organization and acting employee", () => {
    const prompt = buildSystemPrompt({
      organizationName: "משרד לדוגמה",
      businessCategory: "accountant",
      workflowType: "recurring",
      actingUserName: "נועה כהן",
      actingUserEmail: "noa@example.com",
    });
    expect(prompt).toContain("משרד לדוגמה");
    expect(prompt).toContain("נועה כהן");
    expect(prompt).toContain("noa@example.com");
  });

  it("falls back to email when no display name is set", () => {
    const prompt = buildSystemPrompt({
      organizationName: "משרד",
      businessCategory: null,
      workflowType: null,
      actingUserName: null,
      actingUserEmail: "user@example.com",
    });
    expect(prompt).toContain("user@example.com");
  });

  it("never throws regardless of which optional fields are null", () => {
    expect(() =>
      buildSystemPrompt({
        organizationName: "משרד",
        businessCategory: null,
        workflowType: null,
        actingUserName: null,
        actingUserEmail: "user@example.com",
      })
    ).not.toThrow();
  });
});
