// Postgres unique_violation (SQLSTATE 23505). drizzle-orm wraps the raw
// driver error in its own error object with the original underneath
// `.cause` (confirmed empirically — checked both, not assumed), so both
// the top-level error and `.cause` are checked. `constraint_name` is
// populated by postgres-js against a real network Postgres server (what
// actually runs in production) but PGlite's driver layer leaves it
// undefined even though the same violation genuinely occurred (also
// confirmed empirically) — when absent, falls back to matching the
// constraint name inside the error message text, which both drivers
// include. Checking the specific index name (rather than any 23505) keeps
// this from ever accidentally swallowing an unrelated unique violation as
// if it were the expected idempotency race.
export function isUniqueViolation(error: unknown, constraintName: string): boolean {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (!candidate || typeof candidate !== "object") continue;
    if ((candidate as { code?: unknown }).code !== "23505") continue;
    const actualConstraint = (candidate as { constraint_name?: unknown }).constraint_name;
    if (typeof actualConstraint === "string") return actualConstraint === constraintName;
    const message = (candidate as { message?: unknown }).message;
    return typeof message === "string" && message.includes(constraintName);
  }
  return false;
}
