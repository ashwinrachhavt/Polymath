import { describe, expect, it, vi } from "vitest";

/*
 * A configured-but-failing database must surface as a failure, never as an
 * empty history: listWorkspaceActivity lets the error propagate so the
 * (workspace) error boundary renders "This screen could not open" (ASH-163)
 * instead of the feed's empty state.
 */
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: mocks.select } }));

import { listWorkspaceActivity } from "@/domains/audit/queries";

describe("listWorkspaceActivity failure propagation", () => {
  it("rejects when the database read fails", async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(new Error("connection refused")),
    };
    mocks.select.mockReturnValue(chain);
    await expect(
      listWorkspaceActivity({ workspaceId: "ws-1", userId: "u-1" } as never),
    ).rejects.toThrow("connection refused");
  });
});
