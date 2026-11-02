import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The workspace usage ledger behind the Briefing spending tab (ASH-220's
 * stranded ledger row): one row per run with recorded usage in the window,
 * summed in SQL; unpriced runs named; foreign tenants never seen.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let queries: typeof import("@/domains/agents/queries");

afterAll(async () => {
  await handle?.client.end();
});

async function seedRun(
  workspaceId: string,
  objective: string,
  usage: { costUsd?: string; inputTokens?: number; outputTokens?: number }[],
  createdAt?: Date,
) {
  const [profile] = await db
    .insert(agentProfiles)
    .values({ workspaceId, name: `p-${Date.now()}-${Math.random()}` })
    .returning({ id: agentProfiles.id });
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective,
      state: "succeeded",
      policySnapshot: {},
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: agentRuns.id });
  let seq = 0;
  for (const u of usage) {
    seq += 1;
    await db.insert(runEvents).values({ workspaceId, runId: run.id, sequence: seq, type: "usage", data: u });
  }
  return run.id;
}

suite("usage ledger", () => {
  beforeAll(async () => {
    if (!handle) return;
    ({ db } = handle);
    queries = await import("@/domains/agents/queries");
  });

  it("sums recorded cost per run, names unpriced work, and totals honestly", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-${Date.now()}`);
    const priced = await seedRun(workspaceId, "Summarize the lease thread", [
      { costUsd: "0.0042", inputTokens: 1200, outputTokens: 300 },
      { costUsd: "0.0011", inputTokens: 400, outputTokens: 90 },
    ]);
    const unpriced = await seedRun(workspaceId, "Draft the counter-offer", [{ inputTokens: 800, outputTokens: 120 }]);
    const noUsage = await seedRun(workspaceId, "Quiet run", []);

    const ledger = await queries.getUsageLedger(workspaceId, 7);
    expect(ledger.rows.map((r) => r.runId).sort()).toEqual([priced, unpriced].sort());
    const pricedRow = ledger.rows.find((r) => r.runId === priced)!;
    expect(pricedRow.usd).toBe("0.0053");
    expect(pricedRow.pricedEvents).toBe(2);
    expect(pricedRow.inputTokens + pricedRow.outputTokens).toBe(1990);
    expect(ledger.rows.find((r) => r.runId === unpriced)!.usd).toBeNull();
    expect(pricedRow.startedAt === null || pricedRow.startedAt instanceof Date).toBe(true);
    expect(ledger.unpricedRuns).toBe(1);
    expect(ledger.totalUsd).toBe("0.0053");
    void noUsage;
  });

  it("never returns another workspace's runs", async () => {
    const mine = await seedWorkspace(db, `ledger-a-${Date.now()}`);
    const other = await seedWorkspace(db, `ledger-b-${Date.now()}`);
    await seedRun(other.workspaceId, "Foreign run", [{ costUsd: "9.99" }]);

    const ledger = await queries.getUsageLedger(mine.workspaceId, 7);
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.totalUsd).toBeNull();
  });
});
