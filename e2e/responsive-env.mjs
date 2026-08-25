/**
 * Boots a fully isolated environment for the responsive smoke test:
 * a throwaway PostgreSQL, migrations applied, and `next dev` pinned to it.
 *
 * SAFETY: the app must never reach production. `.env.local` points at the
 * production Neon database and Next loads it in dev, so this passes
 * DATABASE_URL through the shell — verified to win over .env.local, because
 * Next's loader does not override variables already in process.env.
 * Nothing here writes to, or connects to, production.
 */
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";

export const PORT = 3987;
export const PG_PORT = 55440;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB = "centro_e2e";
const DATA_DIR = path.join(process.cwd(), ".tmp-e2e-pgdata");
export const DATABASE_URL = `postgres://e2e:e2e@127.0.0.1:${PG_PORT}/${DB}`;

if (/neon\.tech/i.test(DATABASE_URL)) throw new Error("refusing: production host");

let pg = null;
let server = null;

export async function startEnvironment(log = console.log) {
  log("Starting isolated PostgreSQL…");
  await fs.rm(DATA_DIR, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: "e2e", password: "e2e", port: PG_PORT, persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase(DB);

  log("Applying migrations…");
  await run("npx", ["tsx", "scripts/migrate.ts"], { DATABASE_URL });

  // Production build + start rather than `next dev`, for two reasons: Next
  // refuses to run a second dev server on the machine (a developer's own is
  // often already running), and this exercises the bundle that actually
  // ships — including devToolsEnabled() being false, so the test sees the
  // real production UI with no dev controls in it.
  // SKIP_BUILD reuses an existing .next. The build dominates the runtime of
  // this harness, and DATABASE_URL is read at request time (not baked in),
  // so an existing production build is valid against a different database.
  if (process.env.SKIP_BUILD === "1") {
    log("Reusing existing .next build (SKIP_BUILD=1)…");
  } else {
    log("Building (production)…");
    await run("npx", ["next", "build"], { DATABASE_URL });
  }

  // A previous run left a server behind three times in this project, and the
  // harness happily measured it — reporting a STALE BUILD as the current
  // one. Refuse to start rather than talk to someone else's server.
  try {
    const probe = await fetch(BASE_URL, { redirect: "manual" });
    throw new Error(
      `Port ${PORT} is already serving (HTTP ${probe.status}). Refusing to run: ` +
      `results would come from a server this harness did not start, and may be a stale build. ` +
      `Stop the process on port ${PORT} and re-run.`
    );
  } catch (error) {
    if (!/ECONNREFUSED|fetch failed/i.test(String(error))) throw error;
  }

  log("Starting next start…");
  server = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["next", "start", "-p", String(PORT)], {
    env: { ...process.env, DATABASE_URL, NODE_ENV: "production" },
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { if (/error/i.test(String(d))) log("[dev] " + String(d).trim()); });
  let startupError = null;
  server.stderr.on("data", (d) => {
    const text = String(d);
    if (/EADDRINUSE|Failed to start server/i.test(text)) startupError = text.trim().slice(0, 200);
    log("[dev:err] " + text.trim().slice(0, 200));
  });
  server.on("exit", (code) => { if (code !== 0 && code !== null) startupError = startupError ?? `server exited with code ${code}`; });

  await waitForServer(log, () => startupError, server);
  return { baseUrl: BASE_URL, databaseUrl: DATABASE_URL };
}

function run(cmd, args, extraEnv) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      env: { ...process.env, ...extraEnv },
      shell: process.platform === "win32",
      stdio: "inherit",
    });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function waitForServer(log, getStartupError = () => null, child = null) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const failure = getStartupError();
    if (failure) throw new Error(`Server failed to start: ${failure}`);
    if (child && child.exitCode !== null) throw new Error(`Server process exited (code ${child.exitCode}) before becoming ready.`);
    try {
      const res = await fetch(`${BASE_URL}/login`, { redirect: "manual" });
      if (res.status < 500) { log(`Dev server ready at ${BASE_URL}`); return; }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("dev server did not become ready in time");
}

/**
 * Kills the server and everything it spawned.
 *
 * `server` is `npx.cmd`, launched with `shell: true` — so it is a cmd.exe
 * wrapping npx wrapping node. `server.kill()` reaches only the outermost
 * shell: the real `next start` survived every run, kept listening on the
 * port, and kept its stdout/stderr pipes open, which held Node's event loop
 * open too. The harness therefore never exited on its own, and the next run
 * hit the "port already serving" refusal — the stale-server guard firing on
 * the previous run's own leftovers. Killing the tree fixes both.
 */
function killServerTree() {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      child.kill();
    }
  } catch {
    // Best effort: the unref below still lets this process exit.
  }
  // Belt and braces — a live pipe alone is enough to keep Node alive.
  try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); } catch {}
}

export async function stopEnvironment(log = console.log) {
  killServerTree();
  try { await pg?.stop(); } catch {}
  pg = null;
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  log("Environment stopped and data directory removed.");
}
