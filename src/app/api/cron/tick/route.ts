import { NextResponse } from "next/server";
import { runScheduledTasks } from "@/lib/scheduler";

export const dynamic = "force-dynamic";

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

  const result = await runScheduledTasks();
  return NextResponse.json({ status: "ok", ...result });
}
