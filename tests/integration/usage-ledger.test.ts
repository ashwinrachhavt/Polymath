import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The workspace usage ledger behind /command-center/spending: one row per
 * run with recorded usage in the window, summed in SQL; headline totals
 * aggregated over the whole window in SQL (never the visible page);
 * partially-priced runs flagged; numeric precision kept end-to-end; the
 * window anchored to usage-event time, not run creation; foreign tenants
 * never seen.
 *
 * Skipped unless TEST_DATABASE_URL points at a migrated scratch database.
 */

const DAY_MS = 86_400_000;

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let queries: typeof import("@/domains/agents/queries");

afterAll(async () => {
  await handle?.client.end();
});

type SeededUsage = {
  costUsd?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  pricing?: { state: string; usd: string | null };
  /** Override the event's recorded time (default: now). */
  at?: Date;
};

async function seedRun(
  workspaceId: string,
  objective: string,
  usage: SeededUsage[],
  createdAt?: Date,
  profileId?: string,
) {
  let id = profileId;
  if (!id) {
    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId, name: `p-${Date.now()}-${Math.random()}` })
      .returning({ id: agentProfiles.id });
    id = profile.id;
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: id,
      objective,
      state: "succeeded",
      policySnapshot: {},
      ...(createdAt ? { createdAt } : {}),
    })
    .returning({ id: agentRuns.id });
  let seq = 0;
  for (const u of usage) {
    seq += 1;
    const { at, pricing, ...tokens } = u;
    await db.insert(runEvents).values({
      workspaceId,
      runId: run.id,
      sequence: seq,
      type: "usage",
      // The bridge stamps priced events with data.pricing; a seeded raw
      // costUsd without a stamp exercises the pre-stamp fallback.
      data: pricing ? { ...tokens, pricing } : tokens,
      ...(at ? { createdAt: at } : {}),
    });
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
    expect(pricedRow.inputTokens).toBe(1600);
    expect(pricedRow.outputTokens).toBe(390);
    expect(pricedRow.pricingState).toBe("priced");
    expect(ledger.rows.find((r) => r.runId === unpriced)!.usd).toBeNull();
    expect(ledger.rows.find((r) => r.runId === unpriced)!.pricingState).toBe("unpriced");
    expect(pricedRow.startedAt === null || pricedRow.startedAt instanceof Date).toBe(true);
    expect(ledger.unpricedRuns).toBe(1);
    expect(ledger.runCount).toBe(2);
    expect(ledger.totalUsd).toBe("0.0053");
    void noUsage;
  });

  it("aggregates headline totals over the whole window, not the 50-row page", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-page-${Date.now()}`);
    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId, name: `p-${Date.now()}-${Math.random()}` })
      .returning({ id: agentProfiles.id });
    for (let i = 0; i < 55; i += 1) {
      await seedRun(workspaceId, `Bulk run ${i}`, [{ costUsd: "0.01", inputTokens: 10 }], undefined, profile.id);
    }

    const ledger = await queries.getUsageLedger(workspaceId, 7);
    expect(ledger.rows).toHaveLength(50);
    expect(ledger.runCount).toBe(55);
    // 55 x 0.01, summed in SQL over the window — the old page-capped,
    // float-summed headline would have reported 0.5 (and via Number()).
    expect(ledger.totalUsd).toBe("0.55");
    expect(ledger.unpricedRuns).toBe(0);
  });

  it("flags partially-priced runs from priced_events < usage_events", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-partial-${Date.now()}`);
    const partial = await seedRun(workspaceId, "Half-priced run", [
      { costUsd: "0.01", inputTokens: 10 },
      { costUsd: "0.02", inputTokens: 10 },
      { inputTokens: 5 },
    ]);
    const unpriced = await seedRun(workspaceId, "Never priced", [{ inputTokens: 7 }]);

    const ledger = await queries.getUsageLedger(workspaceId, 7);
    const partialRow = ledger.rows.find((r) => r.runId === partial)!;
    expect(partialRow.pricingState).toBe("partial");
    expect(partialRow.pricedEvents).toBe(2);
    expect(partialRow.usageEvents).toBe(3);
    // The priced part still sums; the badge names the gap.
    expect(partialRow.usd).toBe("0.03");
    expect(ledger.rows.find((r) => r.runId === unpriced)!.pricingState).toBe("unpriced");
    // Window-wide honesty: a run with ANY unpriced usage event counts.
    expect(ledger.unpricedRuns).toBe(2);
  });

  it("prices stamped events and names the state by resolver precedence", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-stamps-${Date.now()}`);
    const mixed = await seedRun(workspaceId, "Mixed stamps", [
      { inputTokens: 10, outputTokens: 5, pricing: { state: "estimated", usd: "0.03" } },
      { inputTokens: 10, pricing: { state: "provider-reported", usd: "0.10" } },
    ]);
    const estimatedOnly = await seedRun(workspaceId, "Estimated only", [
      { inputTokens: 3, pricing: { state: "estimated", usd: "0.01" } },
    ]);
    const confirmedZero = await seedRun(workspaceId, "Confirmed zero", [
      { pricing: { state: "confirmed-zero", usd: "0" } },
    ]);
    const stampedUnpriced = await seedRun(workspaceId, "Stamped unpriced", [
      { inputTokens: 3, pricing: { state: "unpriced", usd: null } },
    ]);

    const ledger = await queries.getUsageLedger(workspaceId, 7);
    const byRun = new Map(ledger.rows.map((r) => [r.runId, r]));
    // provider-reported outranks estimated in the resolver's precedence.
    expect(byRun.get(mixed)!.pricingState).toBe("provider-reported");
    expect(byRun.get(mixed)!.usd).toBe("0.13");
    expect(byRun.get(estimatedOnly)!.pricingState).toBe("estimated");
    expect(byRun.get(confirmedZero)!.pricingState).toBe("confirmed-zero");
    expect(byRun.get(confirmedZero)!.usd).toBe("0");
    // A stamp with a null figure prices nothing — the run stays unpriced.
    expect(byRun.get(stampedUnpriced)!.pricingState).toBe("unpriced");
    expect(byRun.get(stampedUnpriced)!.usd).toBeNull();
    expect(ledger.unpricedRuns).toBe(1);
    expect(ledger.totalUsd).toBe("0.14");
  });

  it("keeps numeric precision end-to-end: sums never pass through a JS float", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-precision-${Date.now()}`);
    for (let i = 0; i < 7; i += 1) {
      await seedRun(workspaceId, `Micro run ${i}`, [{ costUsd: "0.000001" }]);
    }
    const ledger = await queries.getUsageLedger(workspaceId, 7);
    // Number() + toFixed(4) rounded this to "0".
    expect(ledger.totalUsd).toBe("0.000007");

    const { workspaceId: ws2 } = await seedWorkspace(db, `ledger-precision2-${Date.now()}`);
    await seedRun(ws2, "Long-decimal run", [{ costUsd: "0.1000001" }, { costUsd: "0.2000002" }]);
    const ledger2 = await queries.getUsageLedger(ws2, 7);
    expect(ledger2.rows[0].usd).toBe("0.3000003");
    expect(ledger2.totalUsd).toBe("0.3000003");
  });

  it("windows by usage-event time, not run creation", async () => {
    const { workspaceId } = await seedWorkspace(db, `ledger-window-${Date.now()}`);
    // An old run whose usage landed now: inside the window.
    const oldRun = await seedRun(
      workspaceId,
      "Long-lived run",
      [{ costUsd: "0.02", inputTokens: 10 }],
      new Date(Date.now() - 10 * DAY_MS),
    );
    // A fresh run whose only usage landed 10 days ago: outside.
    await seedRun(workspaceId, "Fresh run, old usage", [
      { costUsd: "0.50", inputTokens: 10, at: new Date(Date.now() - 10 * DAY_MS) },
    ]);

    const ledger = await queries.getUsageLedger(workspaceId, 7);
    expect(ledger.rows.map((r) => r.runId)).toEqual([oldRun]);
    expect(ledger.runCount).toBe(1);
    expect(ledger.totalUsd).toBe("0.02");
  });

  it("never returns another workspace's runs", async () => {
    const mine = await seedWorkspace(db, `ledger-a-${Date.now()}`);
    const other = await seedWorkspace(db, `ledger-b-${Date.now()}`);
    await seedRun(other.workspaceId, "Foreign run", [{ costUsd: "9.99" }]);

    const ledger = await queries.getUsageLedger(mine.workspaceId, 7);
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.runCount).toBe(0);
    expect(ledger.totalUsd).toBeNull();
  });
});
