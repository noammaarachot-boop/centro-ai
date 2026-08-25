import { describe, expect, it } from "vitest";
import {
  assertMigrationsAllowed,
  migrationsAllowed,
  MigrationNotAllowedError,
} from "./migrationGuard";

// Guards the property that only a Vercel Production deployment (or a run
// that is not on Vercel at all) may migrate the database — the hazard that
// already applied migration 0072 to production from a feature branch's
// Preview build, before merge or approval.

const env = (vercelEnv?: string) => (vercelEnv === undefined ? {} : { VERCEL_ENV: vercelEnv });

describe("migrationsAllowed — explicit allow-list", () => {
  it("1. production → ALLOWED (the intended route)", () => {
    expect(migrationsAllowed(env("production"))).toBe(true);
    expect(() => assertMigrationsAllowed(env("production"))).not.toThrow();
  });

  it("2. preview → BLOCKED (inherits the production DATABASE_URL)", () => {
    expect(migrationsAllowed(env("preview"))).toBe(false);
    expect(() => assertMigrationsAllowed(env("preview"))).toThrow(MigrationNotAllowedError);
  });

  // The regression this rewrite exists to prevent: the previous version
  // blocked only the literal "preview" and let every other value through.
  it("3. unknown values → BLOCKED, including ones that do not exist yet", () => {
    for (const value of ["staging", "branch", "preview-branch", "prod", "PREVIEW", "Production", " production "]) {
      expect(migrationsAllowed(env(value)), value).toBe(false);
      expect(() => assertMigrationsAllowed(env(value)), value).toThrow(MigrationNotAllowedError);
    }
  });

  it("4. VERCEL_ENV unset → ALLOWED (local `npm run db:migrate`, and CI)", () => {
    // This project's dev script is plain `next dev`, not `vercel dev`, so
    // VERCEL_ENV is never set locally — allowing it does not widen the
    // surface, and blocking it would break the normal local workflow.
    expect(migrationsAllowed({})).toBe(true);
    expect(() => assertMigrationsAllowed({})).not.toThrow();
  });

  it("5. development → BLOCKED", () => {
    // Vercel sets "development" only for `vercel dev`, which this project
    // does not use. If it ever appeared it would be running on Vercel
    // infrastructure and could inherit the production DATABASE_URL exactly
    // as Preview does, so it is refused rather than assumed safe.
    expect(migrationsAllowed(env("development"))).toBe(false);
    expect(() => assertMigrationsAllowed(env("development"))).toThrow(MigrationNotAllowedError);
  });

  it("empty string → BLOCKED (an ambiguous value is never permission)", () => {
    expect(migrationsAllowed(env(""))).toBe(false);
  });
});

describe("the error explains itself", () => {
  it("names the offending environment and how to fix it", () => {
    try {
      assertMigrationsAllowed(env("staging"));
      throw new Error("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/"staging"/);
      expect(message).toMatch(/production DATABASE_URL/);
      expect(message).toMatch(/separate DATABASE_URL/);
    }
  });

  it("reports an unset value readably rather than as undefined", () => {
    // Only reachable if the allow-list changes; asserted so the message
    // never degrades into "VERCEL_ENV=undefined".
    expect(new MigrationNotAllowedError(undefined).message).toMatch(/<unset>/);
  });
});
