/**
 * Foreign-run 404 parity at the route-handler level (TODOS.md's HTTP-level ask).
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

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { b, a, holder, type Fixture } from "./_harness";

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
  get withTransaction() {
    // Mirrors the real seam's guardrails (commands/contracts.md: statement
    // and idle-in-transaction timeouts). No JS-side race here either: an
    // abandoned transaction callback leaks its pool slot — the exact wedge
    // class the probe cap had — so the transaction-local statement_timeout
    // is the only bound, exactly as in production.
    return async (fn: (tx: unknown) => Promise<unknown>) =>
      holder.db!.transaction(async (tx: unknown) => {
        // Statement + idle-in-transaction timeouts, transaction-local: the
        // server kills runaway SQL even while the ROLLBACK path is in flight.
        await (tx as { execute: (q: unknown) => Promise<unknown> }).execute(
          sql`select set_config('statement_timeout', '10000', true), set_config('idle_in_transaction_session_timeout', '15000', true)`,
        );
        return fn(tx);
      });
  },
}));

describe("cross-workspace isolation: run stream 404 parity", () => {
  it("the run stream route answers a foreign run id exactly like a missing one (404 parity)", async () => {
    // TODOS.md's HTTP-level ask, pinned: the scoping clause in the stream
    // route (agentRuns.workspaceId = auth.workspaceId) is what makes a
    // foreign id indistinguishable from a missing one — status, body, and
    // content-type must be identical, or the 404 leaks existence.
    const { GET } = await import("@/app/api/v1/runs/[runId]/stream/route");
    const call = (runId: string) =>
      GET(new Request(`https://test.local/api/v1/runs/${runId}/stream`), { params: Promise.resolve({ runId }) });

    const [foreign, missing, malformed] = await Promise.all([
      call(b.rows.agent_runs.ids[0]),
      call(crypto.randomUUID()),
      call("not-a-uuid"),
    ]);
    // A Response body reads exactly once — capture each body up front.
    const [foreignBody, missingBody, malformedBody] = await Promise.all([
      foreign.text(),
      missing.text(),
      malformed.text(),
    ]);

    expect(foreign.status, "a foreign run id must be indistinguishable from a missing one").toBe(missing.status);
    expect(foreignBody, "the foreign-run 404 body differs from the missing-run 404 body").toBe(missingBody);
    expect(foreign.headers.get("content-type"), "the foreign-run 404 content-type differs").toBe(
      missing.headers.get("content-type"),
    );
    expect(foreign.status, "the stream route must 404 a foreign run id").toBe(404);
    expect(malformed.status).toBe(404);
    expect(malformedBody).toBe(missingBody);
  });
});
