import { NextResponse } from "next/server";
import { runScheduledTasks } from "@/lib/scheduler";
import { getDb } from "@/db";
import { jobRuns } from "@/db/schema";

export const dynamic = "force-dynamic";

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

  // Owner Dashboard System Health foundation — previously this tick's
  // outcome only ever reached whoever called this endpoint, once, and was
  // otherwise lost. Recording start/finish here (rather than inside
  // runScheduledTasks itself) keeps this observability concern out of the
  // scheduler's own logic, since that function has a second, unrelated
  // call site (Settings' manual per-organization "run now" button).
  const startedAt = new Date();
  const db = await getDb();

  try {
    const result = await runScheduledTasks();
    await db.insert(jobRuns).values({
      jobName: JOB_NAME,
      startedAt,
      finishedAt: new Date(),
      status: "success",
      resultSummary: result,
    });
    return NextResponse.json({ status: "ok", ...result });
  } catch (error) {
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
