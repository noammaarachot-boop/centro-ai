import type { OwnerHealthSignals } from "@/lib/data/owner/health";

export type OwnerHealthLevel = "healthy" | "warning" | "critical";

export interface OwnerHealthStatus {
  level: OwnerHealthLevel;
  reasons: string[];
}

// Pure — no DB access — so a future alert notifier (Phase 8) can call
// this with freshly-fetched signals and diff against the last-known
// result rather than needing new detection logic, and so it's testable
// without a database. Always returns its reasons when not healthy,
// never a bare color/level.
export function computeHealthStatus(signals: OwnerHealthSignals): OwnerHealthStatus {
  const reasons: string[] = [];

  if (signals.failedJobRunsLast24h > 0) {
    reasons.push(`${signals.failedJobRunsLast24h} הרצות תזמון (cron) נכשלו ב-24 השעות האחרונות`);
  }
  if (signals.criticalAuditEventsLast24h > 0) {
    reasons.push(`${signals.criticalAuditEventsLast24h} אירועים קריטיים ב-24 השעות האחרונות`);
  }
  if (reasons.length > 0) {
    return { level: "critical", reasons };
  }

  if (signals.warningAuditEventsLast24h > 0) {
    return {
      level: "warning",
      reasons: [`${signals.warningAuditEventsLast24h} תקלות חיבור (WhatsApp / Google Drive) ב-24 השעות האחרונות`],
    };
  }

  return { level: "healthy", reasons: [] };
}
