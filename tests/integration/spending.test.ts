import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spendingPolicies, spendingReservations, spendSettlements } from "@/domains/spending/schema";
import { userPreferences } from "@/domains/identity/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The spending invariants the engineering guidelines says run against real Postgres, * because a mock proves the mock works. The ceiling has to hold when claims run
 * at once, settle has to be idempotent, and the per-run ceiling has to fire — * none of which a mock can show.
 * * Skipped unless TEST_DATABASE_URL points at a database with the migrations
 * applied. The commands and the transaction wrapper are imported lazily and * only after DATABASE_URL is pointed at that same database: src/lib/db-transaction.ts
 * reads DATABASE_URL at module load, so a static import would resolve against * the wrong database (or throw without one) and fail this file instead of
 * skipping it. *
 * The seed scaffolding lives in tests/helpers/test-workspace.ts; this file * inserts fresh unique slugs and truncates nothing.
 */ const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let commands: typeof import("@/domains/spending/commands");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  commands = await import("@/domains/spending/commands");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

const TINY = "0.000001";

/*
 * `dailyCeilingUsd` and `perRunCeilingUsd` are numeric(12,4) — four decimal * places. The brief's "0.000003" rounds to 0.0000 on the way in, so every claim
 * is rejected and a test that only counts results passes without proving * anything. These values survive a round trip, and the ceiling is one estimate
 * wide so exactly one of four contenders can win. */
const DAILY = "0.0001";
const PER_RUN = "0.0001";
const ESTIMATE = "0.0001";
/*
 * The hybrid-basis tests need a ceiling wide enough for one claim but not two,
 * with estimates that differ from each other: one claim at 0.0050 fits under
 * 0.0099, and after a settle-below (0.0020) a second one still fits — while
 * two full claims (0.0100) or a settle-above (0.0080 + 0.0050) do not.
 */
const CEILING = "0.0099";

async function seedWs(slug: string, ceilings: { daily?: string; perRun?: string; monthly?: string; tz?: string } = {}) {
  const { workspaceId, userId } = await seedWorkspace(db, slug);
  await db.insert(spendingPolicies).values({
    workspaceId,
    dailyCeilingUsd: ceilings.daily ?? null,
    perRunCeilingUsd: ceilings.perRun ?? null,
    monthlyCeilingUsd: ceilings.monthly ?? null,
    onExceeded: "fail",
  });
  // The ceilings' windows resolve in this timezone (user_preferences is the
  // workspace tz source the reserve path reads).
  if (ceilings.tz) {
    await db.insert(userPreferences).values({ workspaceId, userId, timezone: ceilings.tz });
  }
  return { workspaceId };
}

/** One hour before this month's UTC start: inside the previous month, always in the past. */
function priorUtcMonthEdge(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 3_600_000);
}

/** A settled reservation placed directly in the ledger at a chosen instant. */
async function insertSettledReservation(workspaceId: string, at: Date, usd: string) {
  await db.insert(spendingReservations).values({
    workspaceId,
    runId: null,
    reservedUsd: usd,
    settledUsd: usd,
    status: "settled",
    model: "fixture",
    settledAt: at,
    createdAt: at,
  });
}

suite("spending commands", () => {
  it("reserve respects the daily ceiling across concurrent claims", async () => {
    const ws = await seedWs(`spend-conc-${Date.now()}`, { daily: DAILY });
    const claim = () =>
      withTransaction((tx) =>
        commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: ESTIMATE }),
      );
    // Four at once, for a ceiling one estimate wide: the advisory lock is what
    // makes exactly one win rather than four. More contenders than the brief's
    // two, because two can serialize by luck and pass a broken lock.
    const results = await Promise.all([claim(), claim(), claim(), claim()]);
    const wins = results.filter((r) => r.ok);
    expect(results.length).toBe(4);
    expect(wins.length).toBe(1);
    // Sum of open reservations must never exceed the daily ceiling.
    const open = await db
      .select()
      .from(spendingReservations)
      .where(and(eq(spendingReservations.workspaceId, ws.workspaceId), eq(spendingReservations.status, "reserved")));
    const total = open.reduce((acc, r) => acc + Number(r.reservedUsd), 0);
    expect(total).toBeLessThanOrEqual(Number(DAILY));
  });

  it("settle is idempotent and writes one settlement row", async () => {
    const ws = await seedWs(`spend-settle-${Date.now()}`);
    const r = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: TINY }),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    const first = await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } },
      ),
    );
    const second = await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        { reservationId: r.reservationId, actualUsd: TINY, usage: { input: 1, output: 2 } },
      ),
    );
    expect(first.wasSettled).toBe(true);
    expect(second.wasSettled).toBe(false); // no-op on already-settled
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spendSettlements)
      .where(eq(spendSettlements.reservationId, r.reservationId));
    expect(count).toBe(1);
  });

  it("per-run ceiling blocks an oversized estimate with onExceeded action", async () => {
    const ws = await seedWs(`spend-per-run-${Date.now()}`, { perRun: PER_RUN });
    const r = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "1.00" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.action).toBe("fail");
  });

  it("release frees the reservation", async () => {
    const ws = await seedWs(`spend-release-${Date.now()}`);
    const r = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: TINY }),
    );
    if (!r.ok) throw new Error("reserve should have succeeded");
    await withTransaction((tx) =>
      commands.releaseSpend(tx, { workspaceId: ws.workspaceId }, { reservationId: r.reservationId }),
    );
    const [row] = await db.select().from(spendingReservations).where(eq(spendingReservations.id, r.reservationId));
    expect(row.status).toBe("released");
  });

  it("settle below the reserve frees daily budget for the next claim", async () => {
    const ws = await seedWs(`spend-free-${Date.now()}`, { daily: CEILING });
    const first = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    if (!first.ok) throw new Error("first reserve should have succeeded");
    await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        {
          reservationId: first.reservationId,
          actualUsd: "0.0020",
        },
      ),
    );
    // Hybrid basis: the settled actual (0.0020) replaces the stale estimate,
    // so the same estimate fits again (0.0020 + 0.0050 <= 0.0099). The old
    // reserved-sum basis (0.0050 + 0.0050 > 0.0099) would have blocked it.
    const second = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(second.ok).toBe(true);
  });

  it("a settlement above the reserve raises the daily basis", async () => {
    const ws = await seedWs(`spend-over-${Date.now()}`, { daily: CEILING });
    const first = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0020" }),
    );
    if (!first.ok) throw new Error("first reserve should have succeeded");
    await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        {
          reservationId: first.reservationId,
          actualUsd: "0.0080",
        },
      ),
    );
    // Hybrid basis: the settled actual (0.0080) outruns the estimate, and the
    // next claim sees it (0.0080 + 0.0050 > 0.0099). The reserved-sum basis
    // (0.0020 + 0.0050 = 0.0070) would have let it through — over-spend invisible.
    const second = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.action).toBe("fail");
  });

  it("the monthly ceiling blocks a reservation once the month's basis is over it", async () => {
    const ws = await seedWs(`spend-month-${Date.now()}`, { monthly: CEILING });
    const first = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    if (!first.ok) throw new Error("first reserve should have succeeded");
    await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        {
          reservationId: first.reservationId,
          actualUsd: "0.0080",
        },
      ),
    );
    // The monthly ceiling reads the same hybrid basis: the settled actual
    // (0.0080) counts, so the next claim is over (0.0080 + 0.0050 > 0.0099).
    // A stale-estimate basis (0.0020 + 0.0050) would have allowed it — and
    // before this change no monthly check ran at all.
    const second = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.action).toBe("fail");
  });

  it("the monthly window is the calendar month: last month's settled spend does not count", async () => {
    const ws = await seedWs(`spend-cal-${Date.now()}`, { monthly: CEILING });
    await insertSettledReservation(ws.workspaceId, priorUtcMonthEdge(), "0.0080");
    // Last month's spend is outside the calendar-month window, so 0.0050
    // fits. A window that leaked it in (0.0080 + 0.0050 > 0.0099) would block.
    const first = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(first.ok).toBe(true);
    // And current-month spend does count: settling this claim at 0.0080 puts
    // the month's basis at 0.0080, so the next claim at 0.0050 is over.
    if (!first.ok) throw new Error("first reserve should have succeeded");
    await withTransaction((tx) =>
      commands.settleSpend(
        tx,
        { workspaceId: ws.workspaceId },
        {
          reservationId: first.reservationId,
          actualUsd: "0.0080",
        },
      ),
    );
    const second = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(second.ok).toBe(false);
  });

  it("the monthly window follows the workspace's timezone, not UTC", async () => {
    // Asia/Kolkata is UTC+5:30 year-round: an hour before the UTC month start
    // is already 04:30 on the 1st there, so the instant the UTC window puts
    // in the previous month, the Kolkata window counts against this month.
    const ws = await seedWs(`spend-tz-${Date.now()}`, { monthly: CEILING, tz: "Asia/Kolkata" });
    await insertSettledReservation(ws.workspaceId, priorUtcMonthEdge(), "0.0080");
    const r = await withTransaction((tx) =>
      commands.reserveSpend(tx, { workspaceId: ws.workspaceId }, { runId: null, model: "x", estimateUsd: "0.0050" }),
    );
    expect(r.ok).toBe(false); // 0.0080 + 0.0050 > 0.0099 in the Kolkata month
    if (!r.ok) expect(r.action).toBe("fail");
  });
});
