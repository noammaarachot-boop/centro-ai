import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { runScheduledTasks } from "@/lib/scheduler";
import { sendManualReminder } from "@/lib/manualReminder";
import { diagnoseInbound } from "@/lib/whatsapp/inboundDiagnostics";
import { getDb } from "@/db";
import { jobRuns } from "@/db/schema";
import { captureError } from "@/lib/monitoring/errorReporting";
import { cleanupExpiredRateLimits } from "@/lib/auth/rateLimiter";
import { pruneOldJobRuns } from "@/lib/jobRunRetention";

export const dynamic = "force-dynamic";
// Phase 4.1 remediation — matches the webhook route's own proven ceiling on
// this exact Vercel project/plan (see src/app/api/webhooks/whatsapp/route.ts).
// A tick across tens of organizations (each with several DB round trips,
// WhatsApp sends, and occasional AI calls) can legitimately take longer
// than the platform's old 60s default; without an explicit value here the
// function could be killed mid-run before ever releasing the advisory lock
// below (harmless — pg_try_advisory_xact_lock is transaction-scoped and
// releases automatically the instant the connection drops) but also before
// finishing real work.
export const maxDuration = 180;

const JOB_NAME = "cron.tick";

// Meant to be hit by an external scheduler (Vercel Cron, GitHub Actions
// scheduled workflow, etc.) — there's no in-process cron in a
// serverless-style deployment. CRON_SECRET must match, except in
// development with no secret configured, so a fresh checkout can be
// tested via `curl -X POST localhost:3000/api/cron/tick` without any
// setup.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const provided = request.headers.get("authorization");
    if (provided !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 }
    );
  }

  // Operational single-request trigger.
  //
  // Sends ONE reminder for ONE collection request through exactly the same
  // path as the employee's "שליחת תזכורת עכשיו" button — the shared
  // sendManualReminder — rather than running the whole tick. It exists
  // because verifying a live WhatsApp send previously required either
  // running the full scheduler (which would message every client that
  // happens to be due) or an interactive session, and neither is usable for
  // a controlled production check.
  //
  // Same CRON_SECRET as the tick itself: no new credential, no new
  // authorization model. organizationId and collectionRequestId must agree
  // or the request is not found — the caller cannot reach another tenant.
  const body = await request
    .clone()
    .json()
    .catch(() => null);

  // Inbound diagnostics. Reading whether Meta is actually routing this
  // office's messages to us needs the organization's own token, which is
  // only decryptable in the deployed environment — so without this there is
  // no way to tell "Meta never delivered" from "we received and dropped it".
  // Read-only unless `repair` is set, and both repairs are idempotent.
  if (body && typeof body === "object" && "diagnoseInboundFor" in body) {
    const { diagnoseInboundFor, repair } = body as { diagnoseInboundFor?: string; repair?: boolean };
    if (!diagnoseInboundFor) {
      return NextResponse.json({ error: "diagnoseInboundFor is required" }, { status: 400 });
    }
    const result = await diagnoseInbound(diagnoseInboundFor, { repair: repair === true });
    return NextResponse.json(result, { status: "error" in result ? 422 : 200 });
  }

  if (body && typeof body === "object" && "collectionRequestId" in body) {
    const { organizationId, collectionRequestId } = body as {
      organizationId?: string;
      collectionRequestId?: string;
    };
    if (!organizationId || !collectionRequestId) {
      return NextResponse.json(
        { error: "organizationId and collectionRequestId are both required" },
        { status: 400 }
      );
    }
    const result = await sendManualReminder(organizationId, collectionRequestId, {
      actorType: "system",
    });
    return NextResponse.json(result, { status: result.ok ? 200 : 422 });
  }

  // Owner Dashboard System Health foundation — previously this tick's
  // outcome only ever reached whoever called this endpoint, once, and was
  // otherwise lost. Recording start/finish here (rather than inside
  // runScheduledTasks itself) keeps this observability concern out of the
  // scheduler's own logic, since that function has a second, unrelated
  // call site (Settings' manual per-organization "run now" button).
  const startedAt = new Date();
  const db = await getDb();

  // Phase 4.1 remediation — a real production incident class this closes:
  // the external scheduler (GitHub Actions) has no guarantee against
  // firing a second tick before the first one finishes (a slow tick,
  // scheduler jitter, a manual re-trigger). Without this, two concurrent
  // ticks would both see the same "due" rows across every pass in
  // runScheduledTasks and could double-act on them. pg_try_advisory_xact_lock
  // is non-blocking (returns immediately, never makes a second tick wait)
  // and transaction-scoped (auto-releases the instant this transaction
  // ends, even if the function crashes or is killed mid-run — no manual
  // unlock/cleanup needed, unlike the session-scoped pg_advisory_lock,
  // which would be unsafe to pair with a pooled connection anyway). Same
  // hashtext(...) advisory-lock convention already used in
  // src/lib/storage/driveAdapter.ts.
  let lockAcquired = true;
  try {
    const result = await db.transaction(async (tx) => {
      const lockRows = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${JOB_NAME})) as locked`
      );
      const locked = Array.isArray(lockRows) ? lockRows[0]?.locked : (lockRows as unknown as { rows: Array<{ locked: boolean }> }).rows?.[0]?.locked;
      if (!locked) {
        lockAcquired = false;
        return null;
      }
      // Deliberately NOT nested inside this transaction's own writes —
      // runScheduledTasks issues its own many independent, auto-committing
      // statements (via the shared pooled connection) exactly as it always
      // has. This transaction's only job is to hold the advisory lock open
      // for as long as this await is pending, so a concurrent second
      // tick's own pg_try_advisory_xact_lock call correctly sees it as
      // held for the whole duration of the real work, not just for one
      // instant.
      return await runScheduledTasks();
    });

    if (!lockAcquired) {
      console.log("[cron] tick skipped — a previous tick is still running");
      return NextResponse.json({ status: "skipped", reason: "already_running" });
    }

    // Housekeeping for the shared rate-limit table: only keys never seen
    // again accumulate (an active key resets itself in place), so this is
    // cheap. Deliberately outside the advisory-lock transaction and after
    // the real work — it must never be able to fail the tick.
    let rateLimitRowsPruned = 0;
    try {
      rateLimitRowsPruned = await cleanupExpiredRateLimits();
    } catch (error) {
      console.error("[cron] rate-limit cleanup failed (tick itself succeeded)", error);
    }

    // Retention for this table's own history. Runs BEFORE the row for
    // this tick is written, so the tick always leaves a record behind even
    // if pruning fails. Guarded for the same reason as the cleanup above:
    // housekeeping must never fail the tick.
    let jobRunsPruned = 0;
    try {
      jobRunsPruned = (await pruneOldJobRuns()).deleted;
    } catch (error) {
      console.error("[cron] job_runs retention failed (tick itself succeeded)", error);
    }

    await db.insert(jobRuns).values({
      jobName: JOB_NAME,
      startedAt,
      finishedAt: new Date(),
      status: "success",
      resultSummary: { ...result, rateLimitRowsPruned, jobRunsPruned },
    });
    return NextResponse.json({ status: "ok", ...result, rateLimitRowsPruned, jobRunsPruned });
  } catch (error) {
    captureError(error, { jobName: JOB_NAME });
    await db.insert(jobRuns).values({
      jobName: JOB_NAME,
      startedAt,
      finishedAt: new Date(),
      status: "failed",
      resultSummary: { error: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}
