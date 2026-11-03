/**
 * 01-capture-daybook
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
import { dayStart, dayEnd, workQueries, calendarQueries, auditQueries, captureQueries } from "./_harness";

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
  "src/domains/capture/queries.ts",
  "src/domains/capture/commands.ts",
  "src/domains/daybook/queries.ts",
  "src/domains/daybook/commands.ts",
]);

describe("cross-workspace isolation: 01-capture-daybook", () => {
  it("the fixture seeded both workspaces with disjoint identities", () => {
    for (const [x, y] of [
      [a, b],
      [b, a],
    ] as const) {
      for (const v of y.identity) expect(x.identity.has(v), `identity overlap on ${v}`).toBe(false);
    }
    expect(a.rows.captures.ids).toHaveLength(1);
    expect(b.rows.captures.ids).toHaveLength(2);
  });

  it("high-traffic reads return exactly the caller's workspace rows", async () => {
    const { listCaptures, searchCaptures, getCapture, countInboxTabs } = captureQueries;
    const aCaptures = await listCaptures(a.auth, "all");
    expect(aCaptures.map((r) => r.id)).toEqual(a.rows.captures.ids);

    expect(
      await getCapture(a.auth, b.rows.captures.ids[0]),
      "a foreign capture id resolved under workspace-a auth",
    ).toBeNull();

    expect((await countInboxTabs(a.auth)).all, "the inbox count saw rows beyond workspace-a's one seeded capture").toBe(
      1,
    );

    const searchForeign = await searchCaptures(a.auth, { query: "iso-b", limit: 50, offset: 0 });
    expect(searchForeign.total, "workspace-a search matched workspace-b capture text").toBe(0);
    const searchOwn = await searchCaptures(a.auth, { query: "iso-a", limit: 50, offset: 0 });
    expect(searchOwn.total, "workspace-a search missed its own seeded capture").toBe(1);

    const aTasks = await workQueries.listOpenTasks(a.auth);
    expect(aTasks.map((r) => r.id)).toContain(a.rows.tasks.ids[0]);
    expect(aTasks.map((r) => r.id)).not.toContain(b.rows.tasks.ids[0]);

    const aEvents = await calendarQueries.listEventsBetween(a.auth, dayStart(), dayEnd());
    expect(aEvents.map((r) => r.id)).toContain(a.rows.events.ids[0]);
    expect(aEvents.map((r) => r.id)).not.toContain(b.rows.events.ids[0]);

    const activity = await auditQueries.listWorkspaceActivity(a.auth);
    const summaries = activity.map((r) => r.summary);
    expect(
      summaries.some((s) => s.includes("iso-a")),
      "workspace-a activity feed missed its own event",
    ).toBe(true);
    expect(
      summaries.some((s) => s.includes("iso-b")),
      "workspace-a activity feed carries a workspace-b summary",
    ).toBe(false);
  });
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
      .filter((k) => ["captures", "day_artifact_pins", "artifacts"].includes(k))
      .filter((key) => {
        if (ID_LESS_PROJECTIONS.has(key)) return false;
        const ids = [...(a.rows[key]?.ids ?? []), ...(b.rows[key]?.ids ?? [])];
        return ids.length > 0 && !ids.some((id) => seenIds.has(id));
      });
    expect(
      unobserved,
      "these 01-capture-daybook tables were never observed in any swept result — add a probe or extend the exception list with a reason",
    ).toEqual([]);
  });
});
