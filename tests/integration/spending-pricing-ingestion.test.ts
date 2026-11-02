import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { agentProfiles, agentRuns, runEvents } from "@/domains/agents/schema";
import { modelRateCards } from "@/domains/spending/schema";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * Priced ingestion against real Postgres: the usage event the eve bridge
 * records carries a resolved price in data.pricing; a card edited later
 * prices later events only; a replayed hook dedupes instead of forking
 * history; and the valid_to boundary hands over at exactly the instant the
 * successor card opens. Skipped locally unless TEST_DATABASE_URL points at a
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

suite("usage event pricing at ingestion", () => {
  let db: PostgresJsDatabase;
  let workspaceId: string;
  let userId: string;
  let runId: string;
  let recordUsageEvent: typeof import("@/domains/agents/event-bridge").recordUsageEvent;
  let findEffectiveRateCard: typeof import("@/domains/spending/queries").findEffectiveRateCard;

  const lastUsageEvent = async () =>
    (
      await db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "usage")))
        .orderBy(desc(runEvents.sequence))
        .limit(1)
    )[0];

  const usageEventCount = async () =>
    (
      await db
        .select({ id: runEvents.id })
        .from(runEvents)
        .where(and(eq(runEvents.runId, runId), eq(runEvents.type, "usage")))
    ).length;

  beforeAll(async () => {
    if (!handle) return;
    holder.db = handle.db;
    db = handle.db;
    const seeded = await seedWorkspace(handle.db, `pricing-${Date.now()}`);
    userId = seeded.userId;
    workspaceId = seeded.workspaceId;

    const [profile] = await db
      .insert(agentProfiles)
      .values({ workspaceId, name: "polymath", createdBy: userId, updatedBy: userId })
      .returning();
    const [run] = await db
      .insert(agentRuns)
      .values({
        workspaceId,
        agentProfileId: profile.id,
        objective: "price me",
        policySnapshot: {},
        state: "running",
        model: "gpt-5.4-mini",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();
    runId = run.id;

    // Card v1: the gpt-5.4-mini rates from the seed script's OpenAI source.
    await db.insert(modelRateCards).values({
      workspaceId,
      provider: "openai",
      model: "gpt-5.4-mini",
      inputPerMillion: "0.750000",
      outputPerMillion: "4.500000",
      cacheReadPerMillion: "0.075000",
      effectiveFrom: new Date(Date.now() - 3_600_000),
    });

    // db-transaction reads DATABASE_URL at module load; makeTestDb repointed
    // it to the scratch DB before this dynamic import.
    ({ recordUsageEvent } = await import("@/domains/agents/event-bridge"));
    ({ findEffectiveRateCard } = await import("@/domains/spending/queries"));
  });

  afterAll(async () => {
    if (!handle) return;
    await handle.db.delete(runEvents).where(eq(runEvents.workspaceId, workspaceId));
    await handle.db.delete(agentRuns).where(eq(agentRuns.workspaceId, workspaceId));
    await handle.db.delete(agentProfiles).where(eq(agentProfiles.workspaceId, workspaceId));
    await handle.db.delete(modelRateCards).where(eq(modelRateCards.workspaceId, workspaceId));
    await handle.client.end();
  });

  it("persists estimated pricing next to the raw tokens", async () => {
    if (!handle) return;
    const [card] = await db
      .select()
      .from(modelRateCards)
      .where(and(eq(modelRateCards.workspaceId, workspaceId), eq(modelRateCards.model, "gpt-5.4-mini")))
      .limit(1);

    await recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
      source: { step: 1 },
    });

    const event = await lastUsageEvent();
    // 1M×0.75 + 0.1M×4.50 + 0.5M×0.075 = 1.2375 — numeric strings end to end.
    expect(event.data).toMatchObject({
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      source: { step: 1 },
      pricing: { state: "estimated", usd: "1.237500", rateCardId: card.id },
    });
  });

  it("prices new events with the new card and never rewrites priced history", async () => {
    if (!handle) return;
    const past = await lastUsageEvent();
    const pastPricing = (past.data as { pricing: { usd: string; rateCardId: string } }).pricing;

    // Card change: close v1, open v2 at a different input rate. Events already
    // priced keep their stamp; the next event prices at v2.
    const now = new Date();
    await db.update(modelRateCards).set({ validTo: now }).where(eq(modelRateCards.id, pastPricing.rateCardId));
    const [cardV2] = await db
      .insert(modelRateCards)
      .values({
        workspaceId,
        provider: "openai",
        model: "gpt-5.4-mini",
        inputPerMillion: "1.500000",
        outputPerMillion: "4.500000",
        cacheReadPerMillion: "0.075000",
        effectiveFrom: now,
      })
      .returning();

    await recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
      source: { step: 2 },
    });

    const latest = await lastUsageEvent();
    expect((latest.data as { pricing: { usd: string; rateCardId: string } }).pricing).toEqual({
      state: "estimated",
      usd: "1.987500",
      rateCardId: cardV2.id,
    });
    // History is untouched: event 1 still carries the card that priced it.
    const [reread] = await db.select().from(runEvents).where(eq(runEvents.id, past.id)).limit(1);
    expect((reread.data as { pricing: { usd: string; rateCardId: string } }).pricing).toEqual(pastPricing);
  });

  it("dedupes a replayed usage event even though re-pricing would differ", async () => {
    if (!handle) return;
    const before = await usageEventCount();

    // Same payload + source coordinates as the first event: a replay. The card
    // has changed since, so re-pricing would stamp a different figure — the
    // replay must dedupe, not fork a second priced row.
    const result = await recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000 },
      source: { step: 1 },
    });

    expect(result.deduplicated).toBe(true);
    expect(await usageEventCount()).toBe(before);
  });

  it("stores a provider-reported cost above the card's estimate", async () => {
    if (!handle) return;
    await recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, costUsd: 0.42 },
      source: { step: 3 },
    });
    const event = await lastUsageEvent();
    expect((event.data as { pricing: unknown }).pricing).toEqual({ state: "provider-reported", usd: "0.42" });
  });

  it("stores raw tokens unpriced for a model outside the catalog", async () => {
    if (!handle) return;
    const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.workspaceId, workspaceId)).limit(1);
    const [run] = await db
      .insert(agentRuns)
      .values({
        workspaceId,
        agentProfileId: profile.id,
        objective: "unpriced route",
        policySnapshot: {},
        state: "running",
        model: "claude-hive-x",
        createdBy: userId,
        updatedBy: userId,
      })
      .returning();

    await recordUsageEvent({
      workspaceId,
      runId: run.id,
      usage: { inputTokens: 10, outputTokens: 5 },
      source: { step: 1 },
    });

    const [event] = await db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, run.id), eq(runEvents.type, "usage")))
      .limit(1);
    expect(event.data).toMatchObject({ inputTokens: 10, outputTokens: 5 });
    expect((event.data as { pricing?: unknown }).pricing).toBeUndefined();
  });

  it("hands over to the successor card exactly at the valid_to boundary", async () => {
    if (!handle) return;
    const t0 = new Date(Date.now() - 3_600_000);
    const handover = new Date();
    await db.insert(modelRateCards).values({
      workspaceId,
      provider: "openai",
      model: "validity-probe",
      inputPerMillion: "1.000000",
      outputPerMillion: "1.000000",
      effectiveFrom: t0,
      validTo: handover,
    });
    const [successor] = await db
      .insert(modelRateCards)
      .values({
        workspaceId,
        provider: "openai",
        model: "validity-probe",
        inputPerMillion: "2.000000",
        outputPerMillion: "2.000000",
        effectiveFrom: handover,
      })
      .returning();

    // Before the window: nothing.
    expect(
      await findEffectiveRateCard(workspaceId, "openai", "validity-probe", new Date(Date.now() - 7_200_000)),
    ).toBeNull();
    // Inside the window: the old card.
    const inside = await findEffectiveRateCard(
      workspaceId,
      "openai",
      "validity-probe",
      new Date(Date.now() - 1_800_000),
    );
    expect(inside?.inputPerMillion).toBe("1.000000");
    // At the instant itself: valid_to is exclusive — the successor owns it.
    const atBoundary = await findEffectiveRateCard(workspaceId, "openai", "validity-probe", handover);
    expect(atBoundary?.id).toBe(successor.id);
  });
});
