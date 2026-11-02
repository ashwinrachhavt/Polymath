import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentProfiles, agentRuns } from "@/domains/agents/schema";
import { modelRateCards, spendSettlements, spendingReservations } from "@/domains/spending/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * PR-5's settlement contract, against real Postgres. The rules under test:
 *
 *   - Unknown cost is never zero (Pino's settle-at-estimate call): a run
 *     whose hooks recorded tokens but no price settles at the reservation
 *     estimate, state `estimated` — the old close summed `costUsd` and
 *     silently settled 0 here. This is the regression case.
 *   - A run with no usage events at all settles a KNOWN zero, state
 *     `confirmed-zero` — an observation, not a gap.
 *   - Fully priced usage settles the priced sum, state `priced`.
 *   - A cancel or dead session with recorded usage settles instead of
 *     releasing — releasing is the leak where consumed spend escapes the
 *     settlement ledger and both ceilings. Zero-usage runs still release.
 *   - Settlement rows carry the reservation's run id and model.
 *   - The stuck-reservation reconciler expires terminal-run ghosts and
 *     cap-aged claims, writes `expires_at`, and leaves live runs alone.
 *
 * Runs against the TEST_DATABASE_URL scratch database only.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let bridge: typeof import("@/domains/agents/event-bridge");
let commands: typeof import("@/domains/spending/commands");
let reconcile: typeof import("@/domains/spending/reconcile");
let engineModule: typeof import("@/domains/agents/engine");
let withTransaction: typeof import("@/lib/db-transaction").withTransaction;

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  bridge = await import("@/domains/agents/event-bridge");
  commands = await import("@/domains/spending/commands");
  reconcile = await import("@/domains/spending/reconcile");
  engineModule = await import("@/domains/agents/engine");
  ({ withTransaction } = await import("@/lib/db-transaction"));
});

afterAll(async () => {
  await handle?.client.end();
});

let seedCounter = 0;

/**
 * A workspace, profile, and run each test owns outright — no shared fixtures.
 * `model` lands on the run row, which is where PR-4's ingestion looks the
 * provider up before pricing an event.
 */
async function seedRun(label: string, model?: string) {
  seedCounter += 1;
  const slug = `${label}-${Date.now()}-${seedCounter}`;
  const { userId, workspaceId } = await seedWorkspace(db, slug);
  const [profile] = await db.insert(agentProfiles).values({ workspaceId, name: "polymath" }).returning();
  const [run] = await db
    .insert(agentRuns)
    .values({
      workspaceId,
      agentProfileId: profile.id,
      objective: "test",
      policySnapshot: {},
      state: "running",
      model: model ?? null,
    })
    .returning();
  return { workspaceId, userId, runId: run.id };
}

/** The catalog default and its provider id — the pair the rate-card tests price against. */
const CARD_MODEL = "gemini-3.5-flash-lite";
const CARD_PROVIDER = "gemini";

/** An open reservation for the run, at a nonzero estimate. */
async function reserve(workspaceId: string, runId: string, estimateUsd = "0.500000") {
  const claim = await withTransaction((tx) =>
    commands.reserveSpend(tx, { workspaceId }, { runId, model: CARD_MODEL, estimateUsd }),
  );
  if (!claim.ok) throw new Error("reserve should have succeeded");
  return claim;
}

async function reservationById(reservationId: string) {
  const [row] = await db.select().from(spendingReservations).where(eq(spendingReservations.id, reservationId));
  return row;
}

async function settlementByReservation(reservationId: string) {
  const [row] = await db.select().from(spendSettlements).where(eq(spendSettlements.reservationId, reservationId));
  return row;
}

/** The settlement row's usage payload (jsonb): figure, state, and the per-state mix. */
function usageOf(row: { usage: unknown }): Record<string, unknown> {
  return (row.usage ?? {}) as Record<string, unknown>;
}

suite("spending settlement (PR-5)", () => {
  it("a close with zero usage events settles a confirmed zero", async () => {
    const { workspaceId, runId } = await seedRun("settle-zero-usage", CARD_MODEL);
    const claim = await reserve(workspaceId, runId);

    const closed = await bridge.closeRun({ workspaceId, runId, state: "succeeded" });

    expect(closed.closed).toBe(true);
    expect(closed.settledUsd).toBe("0.000000");
    const reservation = await reservationById(claim.reservationId);
    expect(reservation.status).toBe("settled");
    expect(reservation.settledUsd).toBe("0.000000");
    const settlement = await settlementByReservation(claim.reservationId);
    const usage = usageOf(settlement);
    expect(usage.pricingState).toBe("confirmed-zero");
    // The ledger row says what the run bought: this run, that model.
    expect(settlement.runId).toBe(runId);
    expect(settlement.model).toBe(CARD_MODEL);
  });

  it("tokens but no price settle at the reservation estimate, not zero", async () => {
    const { workspaceId, runId } = await seedRun("settle-estimate", CARD_MODEL);
    const claim = await reserve(workspaceId, runId);

    // Tokens without a rate card and without a provider-reported cost: the
    // ingestion stamp says `unpriced`. The old close settled 0 here.
    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1000, outputTokens: 500 },
      source: { turnId: "t1", stepIndex: 0 },
    });

    const closed = await bridge.closeRun({ workspaceId, runId, state: "succeeded" });

    expect(closed.closed).toBe(true);
    const reservation = await reservationById(claim.reservationId);
    expect(reservation.status).toBe("settled");
    expect(reservation.settledUsd).toBe(reservation.reservedUsd);
    expect(Number(reservation.settledUsd)).toBeGreaterThan(0);
    const settlement = await settlementByReservation(claim.reservationId);
    const usage = usageOf(settlement);
    expect(usage.pricingState).toBe("estimated");
    expect(usage.costUsd).toBe(reservation.reservedUsd);
    expect(usage.stateMix).toMatchObject({ unpriced: 1 });
    expect(settlement.runId).toBe(runId);
    expect(settlement.model).toBe(CARD_MODEL);
  });

  it("fully priced usage settles the priced sum, state priced", async () => {
    const { workspaceId, runId } = await seedRun("settle-priced", CARD_MODEL);
    const claim = await reserve(workspaceId, runId);
    await db.insert(modelRateCards).values({
      workspaceId,
      provider: CARD_PROVIDER,
      model: CARD_MODEL,
      inputPerMillion: "3.000000",
      outputPerMillion: "15.000000",
    });

    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 1_000_000, outputTokens: 0 },
      source: { turnId: "t1", stepIndex: 0 },
    });
    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 0, outputTokens: 2_000_000 },
      source: { turnId: "t1", stepIndex: 1 },
    });

    const closed = await bridge.closeRun({ workspaceId, runId, state: "succeeded" });
    // 1M input at $3/M plus 2M output at $15/M.
    expect(Number(closed.settledUsd)).toBeCloseTo(33, 6);
    const reservation = await reservationById(claim.reservationId);
    expect(reservation.status).toBe("settled");
    const settlement = await settlementByReservation(claim.reservationId);
    const usage = usageOf(settlement);
    expect(usage.pricingState).toBe("priced");
    expect(usage.stateMix).toMatchObject({ estimated: 2 });
  });

  it("a partial mix with any unpriced usage settles at the estimate and notes the mix", async () => {
    const { workspaceId, runId } = await seedRun("settle-mixed", CARD_MODEL);
    const claim = await reserve(workspaceId, runId);

    // Event one is priced (a provider-reported cost); event two carries only
    // tokens with no card to price them against. Unknowable is not zero.
    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { costUsd: 0.25, inputTokens: 10, outputTokens: 5 },
      source: { turnId: "t1", stepIndex: 0 },
    });
    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 100, outputTokens: 50 },
      source: { turnId: "t1", stepIndex: 1 },
    });

    await bridge.closeRun({ workspaceId, runId, state: "succeeded" });
    const reservation = await reservationById(claim.reservationId);
    expect(reservation.settledUsd).toBe(reservation.reservedUsd);
    const settlement = await settlementByReservation(claim.reservationId);
    const usage = usageOf(settlement);
    expect(usage.pricingState).toBe("estimated");
    expect(usage.stateMix).toMatchObject({ "provider-reported": 1, unpriced: 1 });
  });

  it("engine.cancel settles a run whose hooks recorded usage instead of releasing it", async () => {
    const { workspaceId, userId } = await seedRun("cancel-usage");
    const auth = ownerAuth(userId, workspaceId);
    const engine = engineModule.createEngine({
      start: async () => {},
      signal: async () => {},
      cancel: async () => {},
    });
    const { runId } = await engine.start({
      auth,
      profileName: "polymath",
      objective: "settle me on cancel",
      subjects: [],
      estimateUsd: "0.500000",
    });

    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 250, outputTokens: 100 },
      source: { turnId: "t1", stepIndex: 0 },
    });

    await engine.cancel(runId, auth);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("cancelled");
    const [reservation] = await db.select().from(spendingReservations).where(eq(spendingReservations.runId, runId));
    expect(reservation.status).toBe("settled");
    // Settled at the estimate, not released: the usage is on the ledger.
    expect(reservation.settledUsd).toBe(reservation.reservedUsd);
    const settlement = await settlementByReservation(reservation.id);
    expect(settlement.runId).toBe(runId);
    expect(usageOf(settlement).pricingState).toBe("estimated");
  });

  it("engine.cancel still releases a run with no usage events", async () => {
    const { workspaceId, userId } = await seedRun("cancel-no-usage");
    const auth = ownerAuth(userId, workspaceId);
    const engine = engineModule.createEngine({
      start: async () => {},
      signal: async () => {},
      cancel: async () => {},
    });
    const { runId } = await engine.start({
      auth,
      profileName: "polymath",
      objective: "release me on cancel",
      subjects: [],
      estimateUsd: "0.500000",
    });

    await engine.cancel(runId, auth);

    const [reservation] = await db.select().from(spendingReservations).where(eq(spendingReservations.runId, runId));
    expect(reservation.status).toBe("released");
    const settlement = await settlementByReservation(reservation.id);
    expect(settlement).toBeUndefined();
  });

  it("the dead-session path settles instead of releasing when usage exists", async () => {
    const { workspaceId, userId } = await seedRun("dead-session");
    const auth = ownerAuth(userId, workspaceId);
    const { SessionNotActiveError } = await import("@/domains/agents/eve-driver");
    // start opens the session through driver.start; the continue is the first
    // driver.signal call, and by then the gateway has lost the session.
    const engine = engineModule.createEngine({
      start: async () => {},
      signal: async () => {
        throw new SessionNotActiveError("wrun-dead");
      },
      cancel: async () => {},
    });
    const { runId } = await engine.start({
      auth,
      profileName: "polymath",
      objective: "die mid-run",
      subjects: [],
      estimateUsd: "0.500000",
    });

    await bridge.recordUsageEvent({
      workspaceId,
      runId,
      usage: { inputTokens: 10, outputTokens: 0 },
      source: { turnId: "t1", stepIndex: 0 },
    });

    await expect(engine.signal(runId, "continue", auth)).rejects.toThrow();

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(run.state).toBe("failed");
    const [reservation] = await db.select().from(spendingReservations).where(eq(spendingReservations.runId, runId));
    expect(reservation.status).toBe("settled");
    expect(reservation.settledUsd).toBe(reservation.reservedUsd);
  });

  it("the reconciler expires terminal-run ghosts and cap-aged claims, and nothing else", async () => {
    seedCounter += 1;
    const { workspaceId } = await seedWorkspace(db, `reconcile-${Date.now()}-${seedCounter}`);

    const mkRun = async (state: "running" | "succeeded") => {
      const [profile] = await db
        .insert(agentProfiles)
        .values({ workspaceId, name: `recon-${crypto.randomUUID()}` })
        .returning();
      const [run] = await db
        .insert(agentRuns)
        .values({ workspaceId, agentProfileId: profile.id, objective: "test", policySnapshot: {}, state })
        .returning();
      return run.id;
    };
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
    const seedReservation = async (runId: string, createdAt: Date) => {
      const [row] = await db
        .insert(spendingReservations)
        .values({
          workspaceId,
          runId,
          reservedUsd: "0.100000",
          model: CARD_MODEL,
          createdAt,
          updatedAt: createdAt,
        })
        .returning();
      return row;
    };

    // Terminal-run ghost, 2h old: the close that should have settled it never ran.
    const ghost = await seedReservation(await mkRun("succeeded"), hoursAgo(2));
    // Live run, 2h old: parked mid-conversation, still working. Untouched.
    const live = await seedReservation(await mkRun("running"), hoursAgo(2));
    // Run row vanished (hard delete): nothing will ever settle it.
    const dangling = await seedReservation(crypto.randomUUID(), hoursAgo(2));
    // Active run but past the hard cap: no reservation outlives 30 days.
    const capped = await seedReservation(await mkRun("running"), hoursAgo(24 * 31));
    // Fresh and active: the common case. Untouched.
    const fresh = await seedReservation(await mkRun("running"), new Date());

    const result = await reconcile.expireStaleReservations();
    // Other suites' old strays in the scratch database may expire too; the
    // per-row assertions below are the contract, the count is the smoke.
    expect(result.expired).toBeGreaterThanOrEqual(3);

    expect((await reservationById(ghost.id)).status).toBe("expired");
    expect((await reservationById(ghost.id)).expiresAt).not.toBeNull();
    expect((await reservationById(dangling.id)).status).toBe("expired");
    expect((await reservationById(capped.id)).status).toBe("expired");
    expect((await reservationById(live.id)).status).toBe("reserved");
    expect((await reservationById(fresh.id)).status).toBe("reserved");
  });
});
