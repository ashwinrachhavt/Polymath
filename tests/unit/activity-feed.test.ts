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

import { genericSummary, isSafeSummaryAction, listWorkspaceActivity, projectSummary, sanitizeSummary } from "@/domains/audit/queries";

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

describe("fail-closed projection", () => {
  it("delegation grants render as a generic label, never the stored summary with principal keys", () => {
    expect(isSafeSummaryAction("delegation_grant.issued")).toBe(false);
    expect(projectSummary("delegation_grant.issued", 'Delegated 5 capabilities to principal "svc-prod" until 2026-11-01')).toBe(
      "Delegation grant issued recorded",
    );
  });

  it("run feedback renders without its freeform reasons", () => {
    expect(projectSummary("run.feedback.up", "Marked the run good (wrong-facts, leaked private thread text)")).toBe(
      "Run feedback up recorded",
    );
  });

  it("an unknown future action never leaks its raw summary", () => {
    expect(projectSummary("diary.entry_written", "Dear diary, the launch codes are...")).toBe("Diary entry written recorded");
    expect(isSafeSummaryAction("conversation.navigation_answered")).toBe(false);
  });

  it("dynamic integration account actions are allowlisted as settings-visible", () => {
    expect(isSafeSummaryAction("integration.account_suspended")).toBe(true);
    expect(isSafeSummaryAction("integration.account_activated")).toBe(true);
  });

  it("genericSummary never carries stored content", () => {
    expect(genericSummary("spending_policy.created")).toBe("Spending policy created recorded");
  });
});
