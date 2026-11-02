import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { modelRateCards } from "@/domains/spending/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * The history backfill against real Postgres: historical usage events (no
 * pricing stamp) are priced through the PR-4 resolver with the card effective
 * at each event's own timestamp; a row already stamped keeps the price it
 * got; a second pass finds zero candidates and writes zero rows; and the
 * reconciliation summary aggregates with the same predicate the panel's
 * ledger reads. Skipped locally unless TEST_DATABASE_URL points at a
 * migrated scratch DB; required in CI.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;

const holder: { db: PostgresJsDatabase | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));

suite("usage pricing history backfill", () => {
  let db: PostgresJsDatabase;
  let workspaceId: string;
  let userId: string;
  let run1: string;
  let run2: string;
  let cardV1: string;
  let cardV2: string;
  let eventIds: string[] = [];
  let corruptEventId: string;
  let backfill: typeof import("@/domains/spending/backfill");
  let getUsageLedger: typeof import("@/domains/agents/queries").getUsageLedger;
  let getSpendingOverview: typeof import("@/domains/spending/queries").getSpendingOverview;

  const event = async (id: string) => (await db.select().from(runEvents).where(eq(runEvents.id, id)).limit(1))[0];

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    db = handle.db;
    const seeded = await seedWorkspace(handle.db, `backfill-${Date.now()}`);
    userId = seeded.userId;
    workspaceId = seeded.workspaceId;

    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId, name: "polymath", createdBy: userId, updatedBy: userId })
      .returning();
    const [r1] = await db
      .insert(agentRuns)
      .values({
        workspaceId,
        agentProfileId: profile.id,
        objective: "priced history",
        policySnapshot: {},
        state: "succeeded",
        model: "gpt-5.4-mini",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    const [r2] = await db
      .insert(agentRuns)
      .values({
        workspaceId,
        agentProfileId: profile.id,
        objective: "pre-catalog history",
        policySnapshot: {},
        state: "succeeded",
        model: "claude-hive-x",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    run1 = r1.id;
    run2 = r2.id;

    // Two eras of the same model's pricing: v1 closed when v2 opened, so a
    // lookup at each event's own timestamp must land on the right era.
    const [v1] = await db
      .insert(modelRateCards)
      .values({
        workspaceId,
        provider: "openai",
        model: "gpt-5.4-mini",
        inputPerMillion: "1.000000",
        outputPerMillion: "2.000000",
        effectiveFrom: new Date(Date.now() - 48 * 3_600_000),
        validTo: new Date(Date.now() - 3_600_000),
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    const [v2] = await db
      .insert(modelRateCards)
      .values({
        workspaceId,
        provider: "openai",
        model: "gpt-5.4-mini",
        inputPerMillion: "0.750000",
        outputPerMillion: "4.500000",
        cacheReadPerMillion: "0.075000",
        effectiveFrom: new Date(Date.now() - 3_600_000),
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    cardV1 = v1.id;
    cardV2 = v2.id;

    const insert = (values: { runId: string; sequence: number; data: unknown; createdAt: Date }) =>
      db
        .insert(runEvents)
        .values({
          workspaceId,
          runId: values.runId,
          sequence: values.sequence,
          type: "usage",
          data: values.data as Record<string, unknown>,
          createdAt: values.createdAt,
        })
        .returning({ id: runEvents.id });

    const old = new Date(Date.now() - 24 * 3_600_000); // card v1's era
    const fresh = new Date(Date.now() - 60_000); // card v2's era
    const tokens = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 };
    eventIds = [
      // v1 era: 1.00 in / 2.00 out, cache read at the input rate → 1.700000
      (await insert({ runId: run1, sequence: 1, data: tokens, createdAt: old }))[0].id,
      // v2 era: 0.75 in / 4.50 out / 0.075 cache → 1.237500
      (await insert({ runId: run1, sequence: 2, data: tokens, createdAt: fresh }))[0].id,
      // provider-reported cost survives the backfill untouched
      (await insert({ runId: run1, sequence: 3, data: { costUsd: "0.10" }, createdAt: old }))[0].id,
      // out-of-catalog run: honestly unpriced, card lookup never fires
      (await insert({ runId: run2, sequence: 1, data: { inputTokens: 800, outputTokens: 120 }, createdAt: old }))[0].id,
      // a tokenless event is a known zero
      (await insert({ runId: run1, sequence: 5, data: {}, createdAt: old }))[0].id,
      // a null payload prices as zero tokens, the extraction contract's answer
      (await insert({ runId: run1, sequence: 6, data: null, createdAt: old }))[0].id,
      // already stamped by ingestion: the first price it got is the one it keeps
      (
        await insert({
          runId: run1,
          sequence: 4,
          data: { inputTokens: 1, pricing: { usd: "0.42", state: "estimated", rateCardId: v2.id } },
          createdAt: fresh,
        })
      )[0].id,
    ];

    // A corrupt scalar payload would break jsonb_set; the backfill must name
    // it and move on, not fail the run.
    const [corrupt] = await db
      .insert(runEvents)
      .values({
        workspaceId,
        runId: run2,
        sequence: 2,
        type: "usage",
        // The one deliberately corrupt payload: a jsonb scalar, not an object.
        data: sql`'"corrupt"'::jsonb` as unknown as Record<string, unknown>,
        createdAt: new Date(),
      })
      .returning({ id: runEvents.id });
    corruptEventId = corrupt.id;

    // db-transaction and @/lib/db read DATABASE_URL at module load;
    // makeTestDb repointed it to the scratch DB before these dynamic imports.
    backfill = await import("@/domains/spending/backfill");
    ({ getUsageLedger } = await import("@/domains/agents/queries"));
    ({ getSpendingOverview } = await import("@/domains/spending/queries"));
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(runEvents).where(eq(runEvents.workspaceId, workspaceId));
    await handle.db.delete(agentRuns).where(eq(agentRuns.workspaceId, workspaceId));
    await handle.db.delete(agentProfiles).where(eq(agentProfiles.workspaceId, workspaceId));
    await handle.db.delete(modelRateCards).where(eq(modelRateCards.workspaceId, workspaceId));
    await handle.client.end();
  });

  it("plans without writing on a dry run", async () => {
    if (!handle) return;
    const report = await backfill.backfillUsagePricing({ apply: false, workspaceId });
    expect(report.candidates).toBe(6);
    expect(report.written).toBe(0);
    expect(report.unprocessable).toBe(1);
    expect(report.planned).toEqual({
      "provider-reported": 1,
      estimated: 2,
      "confirmed-zero": 2,
      unpriced: 1,
      reconciled: 0,
    });
    expect(report.plannedUsd).toBe("3.037500"); // 1.700000 + 1.237500 + 0.10 + zeros
    // ...and the database is untouched.
    const untouched = await event(eventIds[0]);
    expect(untouched?.data).not.toHaveProperty("pricing");
  });

  it("stamps each event with the card effective at its own timestamp", async () => {
    if (!handle) return;
    const report = await backfill.backfillUsagePricing({ apply: true, workspaceId });
    expect(report.candidates).toBe(6);
    expect(report.written).toBe(6);

    const [v1era, v2era, reported, outOfCatalog, zero, nullPayload, stamped] = await Promise.all(
      eventIds.map((id) => event(id)),
    );
    expect(v1era?.data).toMatchObject({ pricing: { usd: "1.700000", state: "estimated", rateCardId: cardV1 } });
    expect(v2era?.data).toMatchObject({ pricing: { usd: "1.237500", state: "estimated", rateCardId: cardV2 } });
    expect(reported?.data).toMatchObject({ pricing: { usd: "0.10", state: "provider-reported" } });
    expect(outOfCatalog?.data).toMatchObject({ pricing: { usd: null, state: "unpriced" } });
    expect(zero?.data).toMatchObject({ pricing: { usd: "0.000000", state: "confirmed-zero" } });
    expect(nullPayload?.data).toMatchObject({ pricing: { usd: "0.000000", state: "confirmed-zero" } });
    // The row that arrived stamped keeps its own price.
    expect(stamped?.data).toMatchObject({ pricing: { usd: "0.42", state: "estimated" } });
    // The corrupt scalar is named, never written.
    const corrupt = await event(corruptEventId);
    expect(corrupt?.data).toBe("corrupt");
  });

  it("converges: a second pass finds zero candidates and writes zero rows", async () => {
    if (!handle) return;
    const report = await backfill.backfillUsagePricing({ apply: true, workspaceId });
    expect(report.candidates).toBe(0);
    expect(report.written).toBe(0);
    const dry = await backfill.backfillUsagePricing({ apply: false, workspaceId });
    expect(dry.candidates).toBe(0);
    expect(dry.written).toBe(0);
  });

  it("reconciles with the panel: summary matches the ledger's own derivation", async () => {
    if (!handle) return;
    const summary = await backfill.summarizeUsageEventPricing(workspaceId);
    // 7 well-formed events + the corrupt scalar; the summary counts the
    // corrupt row as unpriced — the ledger's own read of it.
    expect(summary.usageEvents).toBe(8);
    expect(summary.pricedEvents).toBe(6);
    expect(summary.unpricedEvents).toBe(2);
    expect(summary.states).toEqual({
      "provider-reported": 1,
      estimated: 3, // two backfilled estimates + the pre-stamped row
      "confirmed-zero": 2,
      unpriced: 2, // out-of-catalog run + the corrupt scalar
      reconciled: 0,
    });
    expect(summary.pricedUsd).toBe("3.457500"); // 1.700000 + 1.237500 + 0.10 + 0.42

    // The ledger the spending panel renders, over a window covering every
    // seeded event: same figures, same predicate, independently computed.
    const ledger = await getUsageLedger(workspaceId, 36_500);
    expect(ledger.totalUsd).toBe("3.457500");
    expect(ledger.runCount).toBe(2);
    expect(ledger.unpricedRuns).toBe(1);

    // The panel's headline (reservations and settlements) still answers after
    // the backfill touched only usage events.
    const overview = await getSpendingOverview(ownerAuth(userId, workspaceId));
    expect(typeof overview.settledToday).toBe("string");
    expect(typeof overview.timezone).toBe("string");
  });

  it("scopes to one workspace when asked", async () => {
    if (!handle) return;
    const [ours] = await handle.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.workspaceId, workspaceId), eq(runEvents.type, "usage")))
      .limit(1);
    expect(ours).toBeDefined();
    // Our events are all stamped by now, so a scoped pass plans nothing —
    // proving the workspace filter binds (and the pass is converged).
    const scoped = await backfill.backfillUsagePricing({ apply: false, workspaceId });
    expect(scoped.candidates).toBe(0);
  });
});
