import { describe, expect, it } from "vitest";
import { computeHealthStatus } from "./health";

const ZERO_SIGNALS = {
  failedJobRunsLast24h: 0,
  warningAuditEventsLast24h: 0,
  criticalAuditEventsLast24h: 0,
};

describe("computeHealthStatus", () => {
  it("is healthy with no reasons when every signal is zero", () => {
    expect(computeHealthStatus(ZERO_SIGNALS)).toEqual({ level: "healthy", reasons: [] });
  });

  it("is warning, with a reason, when only warning-severity events occurred", () => {
    const result = computeHealthStatus({ ...ZERO_SIGNALS, warningAuditEventsLast24h: 3 });
    expect(result.level).toBe("warning");
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("3");
  });

  it("is critical when any job run failed, even with no other signals", () => {
    const result = computeHealthStatus({ ...ZERO_SIGNALS, failedJobRunsLast24h: 1 });
    expect(result.level).toBe("critical");
    expect(result.reasons.some((r) => r.includes("1"))).toBe(true);
  });

  it("is critical when critical audit events occurred", () => {
    const result = computeHealthStatus({ ...ZERO_SIGNALS, criticalAuditEventsLast24h: 2 });
    expect(result.level).toBe("critical");
  });

  it("critical takes priority over warning, and includes both reasons", () => {
    const result = computeHealthStatus({
      failedJobRunsLast24h: 1,
      warningAuditEventsLast24h: 5,
      criticalAuditEventsLast24h: 0,
    });
    expect(result.level).toBe("critical");
    expect(result.reasons).toHaveLength(1);
  });
});
