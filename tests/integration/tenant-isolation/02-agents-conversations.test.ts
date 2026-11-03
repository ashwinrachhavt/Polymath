/**
 * 02-agents-conversations
 *
 * Part of the cross-workspace isolation harness (spec D6): every batch file
 * sweeps a disjoint slice of the 33 scoping-surface modules (art_dZWJ6cGy
 * §5) through the shared fixture in ./_harness, so an unscoped query fails
 * CI (the db vitest project gates pnpm test and the pre-push hook).
 *
 * Batching note: the suite is split across files because a single file that
 * sweeps all 33 modules wedges the vitest runner mid-file (an orphaned
 * postgres-js request leaves the event loop with no work; observed across
 * three pool configurations). Per-file workers get a fresh module registry,
 * so the failure cannot accumulate across batches.
 */

import { describe, expect, it, vi } from "vitest";
import {
  MODULES,
  TABLE_REGISTRY,
  a,
  b,
  seenIds,
  sweepDirection,
  holder,
  type Fixture,
  sweepWithTransaction,
} from "./_harness";

vi.mock("@/lib/db", () => ({
  get db() {
    return holder.dbFor();
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    // Route handlers under test run with the fixture's workspace-a auth; the
    // Clerk session plumbing itself is covered by the auth-resolution suite.
    authedHandler:
      <C>(fn: (auth: Fixture["auth"], request: Request, ctx: C) => Promise<Response>) =>
      async (request: Request, ctx: C) =>
        fn(a.auth, request, ctx),
  };
});
vi.mock("@/domains/agents/eve-driver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/domains/agents/eve-driver")>();
  return {
    ...actual,
    // Without this the stream route answers 503 before its scoping clause
    // runs; the parity test needs the db lookup reachable.
    eveBridgeUnavailableReason: () => null,
  };
});
vi.mock("@/lib/db-transaction", () => ({
  // Commands under test must transact on the same dedicated per-probe client
  // their reads use (the sweepWithTransaction doc owns the why); outside a
  // probe it falls back to the holder db.
  get withTransaction() {
    return sweepWithTransaction;
  },
}));

const OWNED = new Set([
  "src/domains/agents/queries.ts",
  "src/domains/agents/commands.ts",
  "src/domains/conversations/queries.ts",
  "src/domains/conversations/commands.ts",
]);

describe("cross-workspace isolation: 02-agents-conversations", () => {
  for (const entry of MODULES.filter((m) => OWNED.has(m.name))) {
    it(`${entry.name} leaks nothing between workspaces in either direction`, { timeout: 300_000 }, async () => {
      const aToB = await sweepDirection(entry, a, b);
      const bToA = await sweepDirection(entry, b, a);
      expect(aToB + bToA, entry.name).toBeGreaterThan(0);
    });
  }

  it("every seeded table was observed by the sweep, minus documented id-less projections", () => {
    // Tables the sweep cannot observe by id, with the reason each is still
    // covered:
    // - audit_events: the activity feed projects action/subject/summary only
    //   (no ids); the summary markers are walked instead.
    // - superagent_state: no id column; its key/value markers are walked.
    // - day_artifact_pins: the day page projects pins as their artifact; the
    //   joined artifact id is walked instead.
    // - spend_settlements: no seeded row (settleSpend appends them); covered
    //   by the foreign fingerprint.
    const ID_LESS_PROJECTIONS = new Set(["audit_events", "superagent_state", "day_artifact_pins", "spend_settlements"]);
    const unobserved = Object.keys(TABLE_REGISTRY)
      .filter((k) => ["agent_runs", "threads"].includes(k))
      .filter((key) => {
        if (ID_LESS_PROJECTIONS.has(key)) return false;
        const ids = [...(a.rows[key]?.ids ?? []), ...(b.rows[key]?.ids ?? [])];
        return ids.length > 0 && !ids.some((id) => seenIds.has(id));
      });
    expect(
      unobserved,
      "these 02-agents-conversations tables were never observed in any swept result — add a probe or extend the exception list with a reason",
    ).toEqual([]);
  });
});
