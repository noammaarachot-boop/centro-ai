/**
 * Decides whether this process may run database migrations.
 *
 * The hazard this closes: `build` is `npm run db:migrate && next build`, so
 * every Vercel deployment migrates before it builds — and Preview
 * deployments inherit the production DATABASE_URL, because no
 * per-environment database is configured. Pushing ANY branch therefore
 * applied its migrations to the production database, before review, before
 * merge, before anyone approved a deploy. Observed, not theorised:
 * migration 0072 reached production from a feature branch's Preview build.
 *
 * EXPLICIT ALLOW-LIST — fail-CLOSED.
 *
 * An earlier version blocked only the literal "preview" and let everything
 * else through. That was the same mistake as `NODE_ENV !== "production"`,
 * just inverted: a value Vercel might introduce later (say
 * "preview-branch") would have been granted permission to migrate the
 * production database — the exact outcome this guard exists to prevent.
 * Only the two environments known to be safe are listed; anything else is
 * refused, including values that do not exist yet.
 */

/** Just the shape we read — avoids NodeJS.ProcessEnv, which demands NODE_ENV. */
export type EnvLike = Record<string, string | undefined>;

export class MigrationNotAllowedError extends Error {
  constructor(readonly vercelEnv: string | undefined) {
    super(
      `Refusing to run migrations from this environment (VERCEL_ENV=${
        vercelEnv === undefined ? "<unset>" : `"${vercelEnv}"`
      }).\n` +
        "Migrations are permitted only from a Vercel Production deployment, " +
        "or from a local/CI run where VERCEL_ENV is not set.\n" +
        "Preview and every other Vercel environment inherit the production " +
        "DATABASE_URL, so migrating from them would change the production " +
        "database before the change is merged or approved.\n" +
        "Fix: configure a separate DATABASE_URL for that environment in " +
        "Vercel, or run migrations from the production deployment only."
    );
    this.name = "MigrationNotAllowedError";
  }
}

/**
 * The only environments permitted to migrate.
 *
 * `undefined` covers every run that is not a Vercel deployment at all —
 * `npm run db:migrate` on a developer machine, and CI. This project's local
 * dev script is plain `next dev` (not `vercel dev`), so VERCEL_ENV is never
 * set locally and this does not widen the surface.
 *
 * "development" is deliberately NOT here. Vercel sets it only for
 * `vercel dev`, which this project does not use; if it ever appeared it
 * would be running on Vercel infrastructure and could inherit the
 * production DATABASE_URL exactly as Preview does. Blocking it costs
 * nothing real and removes a way in.
 */
const MIGRATION_ALLOWED_ENVIRONMENTS: ReadonlyArray<string | undefined> = ["production", undefined];

/** True when this environment is permitted to run migrations. */
export function migrationsAllowed(env: EnvLike = process.env): boolean {
  return MIGRATION_ALLOWED_ENVIRONMENTS.some((allowed) => allowed === env.VERCEL_ENV);
}

/** Throws unless this environment is explicitly permitted. */
export function assertMigrationsAllowed(env: EnvLike = process.env): void {
  if (!migrationsAllowed(env)) throw new MigrationNotAllowedError(env.VERCEL_ENV);
}
