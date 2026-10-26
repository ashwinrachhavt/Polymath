import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Feed safety contract:
 * - a configured-but-failing database must surface as a failure, never as an
 *   empty history: the error propagates to the (workspace) error boundary
 *   ("This screen could not open", ASH-163) instead of the empty state.
 * - private Supervisor threads never join the member-wide feed (respond.ts
 *   treats a thread as one member's private exchange).
 * - integration.connection_failed keeps the established-visible
 *   provider/alias prefix and drops the freeform provider reason.
 */
const mocks = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select: mocks.select } }));

import { listWorkspaceActivity, sanitizeSummary } from "@/domains/audit/queries";

const auth = { workspaceId: "ws-1", userId: "u-1" } as never;

beforeEach(() => mocks.select.mockReset());

describe("listWorkspaceActivity failure propagation", () => {
  it("rejects when the database read fails", async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockRejectedValue(new Error("connection refused")),
    };
    mocks.select.mockReturnValue(chain);
    await expect(listWorkspaceActivity(auth)).rejects.toThrow("connection refused");
  });
});

describe("sanitizeSummary", () => {
  it("strips the freeform provider reason from connection failures", () => {
    expect(
      sanitizeSummary("integration.connection_failed", 'Connection failed: notion as "Team wiki" — 401 invalid_token eyJhbGciOi'),
    ).toBe('Connection failed: notion as "Team wiki"');
  });

  it("keeps a connection failure summary that carries no reason suffix", () => {
    expect(sanitizeSummary("integration.connection_failed", 'Connection failed: notion as "Team wiki"')).toBe(
      'Connection failed: notion as "Team wiki"',
    );
  });

  it("leaves code-authored summaries of other actions untouched", () => {
    expect(sanitizeSummary("event.created", 'Created event "Roadmap sync"')).toBe('Created event "Roadmap sync"');
    expect(sanitizeSummary("capture.transcribed", "Transcribed with fixture (120 chars)")).toBe("Transcribed with fixture (120 chars)");
  });
});
