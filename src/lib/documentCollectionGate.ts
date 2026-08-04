// Pure decision for the automated document-collection gate, extracted from
// conversationOrchestration.ts's sendOutboundMessage so the rule can be unit
// tested without a database. The rule, in one place:
//
//   • A "manual" (human-initiated) send is ALWAYS allowed — Send Now,
//     Initiate, an employee's own reply. Never gated.
//   • An "employee" free-text send is ALWAYS allowed for the same reason
//     (it only ever happens inside an already-open, human-driven
//     conversation).
//   • An autonomous "automated" template ("ai") send runs only while the
//     org's documentCollectionEnabled gate — and the narrower per-service
//     pause and business-hours gates — all allow it.

export type SendTrigger = "manual" | "automated";
export type SendSenderType = "ai" | "employee";

export type GateBlockReason =
  | "document_collection_disabled"
  | "service_automation_paused"
  | "outside_business_hours";

export interface AutomationGateInputs {
  senderType: SendSenderType;
  trigger: SendTrigger;
  documentCollectionEnabled: boolean;
  automationPaused: boolean;
  withinBusinessHours: boolean;
}

export type GateDecision = { allowed: true } | { allowed: false; reason: GateBlockReason };

export function evaluateAutomationGate(inputs: AutomationGateInputs): GateDecision {
  // Manual sends and employee free-text are never gated.
  if (inputs.trigger === "manual" || inputs.senderType === "employee") {
    return { allowed: true };
  }
  if (!inputs.documentCollectionEnabled) {
    return { allowed: false, reason: "document_collection_disabled" };
  }
  if (inputs.automationPaused) {
    return { allowed: false, reason: "service_automation_paused" };
  }
  if (!inputs.withinBusinessHours) {
    return { allowed: false, reason: "outside_business_hours" };
  }
  return { allowed: true };
}
