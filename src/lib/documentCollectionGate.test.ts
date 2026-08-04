import { describe, expect, it } from "vitest";
import { evaluateAutomationGate } from "./documentCollectionGate";

// Baseline: an autonomous ("automated" + "ai") send with every gate open.
const openAutomated = {
  senderType: "ai" as const,
  trigger: "automated" as const,
  documentCollectionEnabled: true,
  automationPaused: false,
  withinBusinessHours: true,
};

describe("evaluateAutomationGate — manual send is always allowed", () => {
  it("allows a manual send even when documentCollectionEnabled is false", () => {
    const decision = evaluateAutomationGate({
      ...openAutomated,
      trigger: "manual",
      documentCollectionEnabled: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows a manual send even when paused and outside business hours", () => {
    const decision = evaluateAutomationGate({
      senderType: "ai",
      trigger: "manual",
      documentCollectionEnabled: false,
      automationPaused: true,
      withinBusinessHours: false,
    });
    expect(decision.allowed).toBe(true);
  });

  it("allows an employee free-text send regardless of the gate", () => {
    const decision = evaluateAutomationGate({
      senderType: "employee",
      trigger: "automated",
      documentCollectionEnabled: false,
      automationPaused: true,
      withinBusinessHours: false,
    });
    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateAutomationGate — automated send respects documentCollectionEnabled", () => {
  it("blocks an automated send when documentCollectionEnabled is false", () => {
    const decision = evaluateAutomationGate({ ...openAutomated, documentCollectionEnabled: false });
    expect(decision).toEqual({ allowed: false, reason: "document_collection_disabled" });
  });

  it("allows an automated send when documentCollectionEnabled is true and all gates open", () => {
    const decision = evaluateAutomationGate(openAutomated);
    expect(decision.allowed).toBe(true);
  });

  it("blocks an automated send when the service is paused (even if enabled)", () => {
    const decision = evaluateAutomationGate({ ...openAutomated, automationPaused: true });
    expect(decision).toEqual({ allowed: false, reason: "service_automation_paused" });
  });

  it("blocks an automated send outside business hours (even if enabled)", () => {
    const decision = evaluateAutomationGate({ ...openAutomated, withinBusinessHours: false });
    expect(decision).toEqual({ allowed: false, reason: "outside_business_hours" });
  });

  it("reports document_collection_disabled ahead of the narrower gates", () => {
    const decision = evaluateAutomationGate({
      ...openAutomated,
      documentCollectionEnabled: false,
      automationPaused: true,
      withinBusinessHours: false,
    });
    expect(decision).toEqual({ allowed: false, reason: "document_collection_disabled" });
  });
});
