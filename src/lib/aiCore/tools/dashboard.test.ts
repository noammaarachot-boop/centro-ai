import { describe, expect, it, vi } from "vitest";

const getDashboardCounts = vi.fn();
const listQueue = vi.fn();
const listBusinessTypeSuggestions = vi.fn();
const listPendingConfirmationsForDashboard = vi.fn();

vi.mock("@/lib/data/dashboard", () => ({
  getDashboardCounts: (...args: unknown[]) => getDashboardCounts(...args),
  listQueue: (...args: unknown[]) => listQueue(...args),
  listBusinessTypeSuggestions: (...args: unknown[]) => listBusinessTypeSuggestions(...args),
  listPendingConfirmationsForDashboard: (...args: unknown[]) => listPendingConfirmationsForDashboard(...args),
}));

const { createDashboardTools } = await import("./dashboard");

const CTX = { organizationId: "org-1", actingUserId: "user-1" };

describe("list_dashboard_queue dispatch", () => {
  // Regression test for the exact real gap found while building this:
  // listQueue (src/lib/data/dashboard.ts) doesn't itself handle
  // "business_type_suggestions"/"pending_confirmations" — they're
  // client-shaped, not collection-request-shaped, with their own
  // dedicated functions. This dispatch must route each of the 7 queue
  // values to the correct underlying function.
  it("routes business_type_suggestions to its own dedicated function, not listQueue", async () => {
    listBusinessTypeSuggestions.mockResolvedValueOnce([{ id: "c1" }]);
    const tools = createDashboardTools(CTX);
    const result = await tools.list_dashboard_queue.execute!({ queue: "business_type_suggestions" }, {} as never);
    expect(result).toEqual([{ id: "c1" }]);
    expect(listBusinessTypeSuggestions).toHaveBeenCalledWith("org-1");
    expect(listQueue).not.toHaveBeenCalled();
  });

  it("routes pending_confirmations to its own dedicated function, not listQueue", async () => {
    listPendingConfirmationsForDashboard.mockResolvedValueOnce([{ id: "pc1" }]);
    const tools = createDashboardTools(CTX);
    const result = await tools.list_dashboard_queue.execute!({ queue: "pending_confirmations" }, {} as never);
    expect(result).toEqual([{ id: "pc1" }]);
    expect(listPendingConfirmationsForDashboard).toHaveBeenCalledWith("org-1");
    expect(listQueue).not.toHaveBeenCalled();
  });

  it.each(["active", "waiting_for_client", "needs_review", "processing_documents", "completed_today"] as const)(
    "routes %s to listQueue",
    async (queue) => {
      listQueue.mockResolvedValueOnce([{ id: "cr1" }]);
      const tools = createDashboardTools(CTX);
      const result = await tools.list_dashboard_queue.execute!({ queue }, {} as never);
      expect(result).toEqual([{ id: "cr1" }]);
      expect(listQueue).toHaveBeenCalledWith("org-1", queue);
    }
  );

  it("get_dashboard_counts passes through to getDashboardCounts scoped to the org", async () => {
    getDashboardCounts.mockResolvedValueOnce({ active: { count: 1, percentage: 100 } });
    const tools = createDashboardTools(CTX);
    const result = await tools.get_dashboard_counts.execute!({}, {} as never);
    expect(result).toEqual({ active: { count: 1, percentage: 100 } });
    expect(getDashboardCounts).toHaveBeenCalledWith("org-1");
  });
});
