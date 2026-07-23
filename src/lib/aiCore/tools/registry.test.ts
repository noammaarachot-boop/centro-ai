import { describe, expect, it } from "vitest";
import { buildToolRegistry } from "./registry";

const CTX = { organizationId: "00000000-0000-0000-0000-000000000001", actingUserId: "00000000-0000-0000-0000-000000000002" };

describe("buildToolRegistry", () => {
  it("assembles every tool from every factory with no name collisions", () => {
    const registry = buildToolRegistry(CTX);
    const names = Object.keys(registry);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_clients",
        "search_clients",
        "get_client",
        "list_client_services",
        "list_collection_requests",
        "get_collection_request",
        "list_services",
        "get_service",
        "get_dashboard_counts",
        "list_dashboard_queue",
        "query_audit_log",
        "get_organization_info",
        "get_drive_folder_info",
        "get_drive_file_info",
      ])
    );
  });

  it("every tool has a non-empty description (the model relies on these to choose correctly)", () => {
    const registry = buildToolRegistry(CTX);
    for (const [name, definition] of Object.entries(registry)) {
      expect(definition.description, name).toBeTruthy();
      expect(definition.description!.length, name).toBeGreaterThan(10);
    }
  });

  it("builds independent tool sets per call — no shared mutable state across organizations", () => {
    const a = buildToolRegistry(CTX);
    const b = buildToolRegistry({ ...CTX, organizationId: "00000000-0000-0000-0000-000000000099" });
    expect(a).not.toBe(b);
    expect(a.list_clients).not.toBe(b.list_clients);
  });
});
