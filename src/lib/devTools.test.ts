import { afterEach, describe, expect, it, vi } from "vitest";

// Guards the launch-blocking property: development-only tooling —
// "run the scheduler now" (which really sends WhatsApp messages to real
// clients), the inbound-message simulator, the Drive-deletion simulator —
// must be unreachable from a production tenant.
//
// Hiding the UI is not enough on its own: a Server Action stays callable
// from the browser even when it is never rendered, so these assert the
// SERVER-SIDE gate, which is the actual boundary.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

const { devToolsEnabled, assertDevToolsEnabled } = await import("./devTools");

function setNodeEnv(value: string) {
  vi.stubEnv("NODE_ENV", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("devToolsEnabled — explicit allowlist, fail-closed", () => {
  it("allows exactly the two development environments", () => {
    setNodeEnv("development");
    expect(devToolsEnabled()).toBe(true);
    setNodeEnv("test");
    expect(devToolsEnabled()).toBe(true);
  });

  it("is FALSE in production — the property this exists to guarantee", () => {
    setNodeEnv("production");
    expect(devToolsEnabled()).toBe(false);
  });

  // The reason this is an allowlist and not `!== "production"`: every one
  // of these reads as "not production" and would otherwise unlock every
  // tool on a real deployment.
  it("BLOCKS an unset NODE_ENV", () => {
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    expect(devToolsEnabled()).toBe(false);
  });

  it("BLOCKS an empty NODE_ENV", () => {
    setNodeEnv("");
    expect(devToolsEnabled()).toBe(false);
  });

  it("BLOCKS a differently-cased 'Production'", () => {
    setNodeEnv("Production");
    expect(devToolsEnabled()).toBe(false);
    setNodeEnv("PRODUCTION");
    expect(devToolsEnabled()).toBe(false);
  });

  it("BLOCKS any arbitrary or unknown value", () => {
    for (const value of ["staging", "prod", "preview", "qa", "developement", " development ", "TEST"]) {
      setNodeEnv(value);
      expect(devToolsEnabled(), `expected "${value}" to be blocked`).toBe(false);
    }
  });
});

describe("assertDevToolsEnabled", () => {
  it("blocks in production — a rendered-or-not UI is irrelevant to a callable action", () => {
    setNodeEnv("production");
    expect(() => assertDevToolsEnabled()).toThrow("NEXT_NOT_FOUND");
  });

  it("does not block in the allowed development environments", () => {
    setNodeEnv("development");
    expect(() => assertDevToolsEnabled()).not.toThrow();
    setNodeEnv("test");
    expect(() => assertDevToolsEnabled()).not.toThrow();
  });

  // The guard must inherit the allowlist, not re-derive its own condition.
  it("blocks on every unexpected environment, not just the literal 'production'", () => {
    for (const value of ["", "Production", "staging", "prod"]) {
      setNodeEnv(value);
      expect(() => assertDevToolsEnabled(), `expected "${value}" to block`).toThrow("NEXT_NOT_FOUND");
    }
    vi.stubEnv("NODE_ENV", undefined as unknown as string);
    expect(() => assertDevToolsEnabled()).toThrow("NEXT_NOT_FOUND");
  });

  it("uses notFound() rather than a 403, so production never advertises these endpoints exist", () => {
    setNodeEnv("production");
    // The mock above turns notFound() into this exact error; a plain
    // "forbidden" would confirm the route is real.
    expect(() => assertDevToolsEnabled()).toThrow("NEXT_NOT_FOUND");
  });
});
