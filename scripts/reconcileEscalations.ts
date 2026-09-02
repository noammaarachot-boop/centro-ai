/**
 * Reconciles requests still carrying the pre-refactor "escalated" status.
 *
 * Dry-run by default: it prints exactly which rows would change and how, and
 * writes nothing. Pass --apply to execute.
 *
 *   npx tsx scripts/reconcileEscalations.ts
 *   npx tsx scripts/reconcileEscalations.ts --apply
 *
 * Safe to run repeatedly — see src/lib/attention/reconcileEscalations.ts.
 */
import {
  applyEscalationReconciliation,
  clearEscalationsOnTerminalRequests,
  planEscalationReconciliation,
} from "@/lib/attention/reconcileEscalations";

async function main() {
  const apply = process.argv.includes("--apply");
  const plan = await planEscalationReconciliation();

  if (plan.rows.length === 0) {
    console.log("Nothing to reconcile — no request is carrying status='escalated'.");
  } else {
    console.log(
      `${plan.rows.length} request(s) across ${plan.organizationsAffected} organization(s) would change:\n`
    );
    for (const row of plan.rows) {
      console.log(
        [
          `  ${row.collectionRequestId}`,
          `    org            ${row.organizationId}`,
          `    status         escalated -> ${row.toStatus}`,
          `    escalated_at   ${row.escalatedAt?.toISOString() ?? "null (already marked handled)"}`,
          `    dismissed      ${row.alreadyDismissed ? "yes — escalation cleared" : "no — stays in attention"}`,
        ].join("\n")
      );
    }
  }

  if (!apply) {
    console.log("\nDRY RUN — nothing was written. Re-run with --apply to execute.");
    return;
  }

  const applied = await applyEscalationReconciliation(plan);
  const terminalCleared = await clearEscalationsOnTerminalRequests();
  console.log(`\nApplied to ${applied} request(s).`);
  console.log(`Cleared a stale escalation flag on ${terminalCleared} finished request(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
