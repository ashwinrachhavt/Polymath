import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spendingReservations, spendSettlements } from "@/domains/spending/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Integration coverage for the spending surface added in ASH-139 C06:
 * policy upsert (insert on first save, version-checked update after, stale
 * write and duplicate-insert rejected), rate-card history (exact-match
 * conflict), and the overview read (per-workspace sums, null policy handled).
 *
 * Same scaffolding rules as spending.test.ts: TEST_DATABASE_URL gates the
 * suite, the domain modules are imported lazily so DATABASE_URL is pointed at
 * the scratch database before db-transaction reads it, and seeds use fresh
 * unique slugs instead of truncating.
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let policy: typeof import("@/domains/spending/policy");
let queries: typeof import("@/domains/spending/queries");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  policy = await import("@/domains/spending/policy");
  queries = await import("@/domains/spending/queries");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("spending policy, rate cards and overview", () => {
  it("inserts the policy on first save, then updates it version-checked", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `spend-pol-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    const created = await policy.upsertSpendingPolicy(auth, {
      dailyCeilingUsd: "10.00",
      monthlyCeilingUsd: null,
      perRunCeilingUsd: "1.50",
      onExceeded: "pause",
      expectedVersion: null,
    });
    expect(created.version).toBe(1);
    expect(Number(created.dailyCeilingUsd)).toBeCloseTo(10, 4);

    const updated = await policy.upsertSpendingPolicy(auth, {
      dailyCeilingUsd: "25.00",
      monthlyCeilingUsd: "500.00",
      perRunCeilingUsd: "2.00",
      onExceeded: "fail",
      expectedVersion: 1,
    });
    expect(updated.version).toBe(2);
    expect(Number(updated.dailyCeilingUsd)).toBeCloseTo(25, 4);
    expect(Number(updated.monthlyCeilingUsd)).toBeCloseTo(500, 4);
    expect(updated.onExceeded).toBe("fail");
  });

  it("rejects a stale write and a second insert against the same workspace", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `spend-stale-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    await policy.upsertSpendingPolicy(auth, {
      dailyCeilingUsd: "10.00",
      monthlyCeilingUsd: null,
      perRunCeilingUsd: null,
      onExceeded: "pause",
      expectedVersion: null,
    });
    // Current version is 1; claiming first-save again is a stale write...
    await expect(
      policy.upsertSpendingPolicy(auth, {
        dailyCeilingUsd: "5.00",
        monthlyCeilingUsd: null,
        perRunCeilingUsd: null,
        onExceeded: "pause",
        expectedVersion: null,
      }),
    ).rejects.toThrow(policy.StaleWriteError);
    // ...and so must an update against a version the writer never saw.
    await expect(
      policy.upsertSpendingPolicy(auth, {
        dailyCeilingUsd: "5.00",
        monthlyCeilingUsd: null,
        perRunCeilingUsd: null,
        onExceeded: "pause",
        expectedVersion: 99,
      }),
    ).rejects.toThrow(policy.StaleWriteError);
  });

  it("creates rate cards and rejects an exact (provider, model, effectiveFrom) duplicate", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `spend-rates-${Date.now()}`);
    const auth = ownerAuth(userId, workspaceId);

    // A fixed effective time for both inserts: Postgres stores timestamptz at
    // microsecond precision and a defaultNow() value round-trips through JS at
    // milliseconds, so reusing the returned Date would not be an exact match.
    const effective = new Date("2026-10-01T00:00:00Z");
    const card = await policy.createRateCard(auth, {
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      inputPerMillion: "0.25",
      outputPerMillion: "2.00",
      effectiveFrom: effective,
    });
    expect(card.provider).toBe("openrouter");
    expect(Number(card.inputPerMillion)).toBeCloseTo(0.25, 6);

    await expect(
      policy.createRateCard(auth, {
        provider: "openrouter",
        model: "openai/gpt-5-mini",
        inputPerMillion: "0.30",
        outputPerMillion: "2.10",
        effectiveFrom: effective,
      }),
    ).rejects.toThrow(policy.ConflictError);

    // A later effective time is a new price, not a conflict.
    const newer = await policy.createRateCard(auth, {
      provider: "openrouter",
      model: "openai/gpt-5-mini",
      inputPerMillion: "0.30",
      outputPerMillion: "2.10",
      effectiveFrom: new Date(effective.getTime() + 60_000),
    });
    expect(newer.id).not.toBe(card.id);
  });

  it("overview sums only the caller's workspace and reflects the policy", async () => {
    const a = await seedWorkspace(db, `spend-ov-a-${Date.now()}`);
    const b = await seedWorkspace(db, `spend-ov-b-${Date.now()}`);
    const authA = ownerAuth(a.userId, a.workspaceId);

    await policy.upsertSpendingPolicy(authA, {
      dailyCeilingUsd: "25.00",
      monthlyCeilingUsd: null,
      perRunCeilingUsd: null,
      onExceeded: "pause",
      expectedVersion: null,
    });

    // Open claim in A, plus noise in B that must not leak into A's sums.
    const [openA] = await db
      .insert(spendingReservations)
      .values({ workspaceId: a.workspaceId, reservedUsd: "3.00", model: "openai/gpt-5-mini" })
      .returning();
    await db.insert(spendingReservations).values({
      workspaceId: b.workspaceId,
      reservedUsd: "7.00",
      model: "openai/gpt-5-mini",
    });
    // A settled claim in A: reservation first, then the ledger row against it.
    const [settledResA] = await db
      .insert(spendingReservations)
      .values({
        workspaceId: a.workspaceId,
        reservedUsd: "2.00",
        settledUsd: "1.25",
        status: "settled",
        model: "openai/gpt-5-mini",
        settledAt: new Date(),
      })
      .returning();
    await db.insert(spendSettlements).values({
      workspaceId: a.workspaceId,
      reservationId: settledResA.id,
      amountUsd: "1.25",
      model: "openai/gpt-5-mini",
      usage: { input: 1000, output: 500 },
    });

    const overview = await queries.getSpendingOverview(authA);
    expect(Number(overview.policy?.dailyCeilingUsd)).toBeCloseTo(25, 4);
    expect(Number(overview.openReservedToday)).toBeCloseTo(3.0, 4);
    expect(Number(overview.settledToday)).toBeCloseTo(1.25, 4);
    expect(Number(overview.settledThisMonth)).toBeCloseTo(1.25, 4);
    // The engine charges settled claims at their reserved estimate against the
    // ceiling (commands.ts sums reserved_usd for reserved+settled); the overview
    // mirrors that: 25 - (3 open + 2 reserved-then-settled) = 20.
    expect(Number(overview.remainingToday)).toBeCloseTo(25 - 3 - 2, 4);
    expect(overview.openReservations.map((r) => r.id)).toEqual([openA.id]);
  });

  it("overview without a policy returns null ceilings, not an error", async () => {
    const { userId, workspaceId } = await seedWorkspace(db, `spend-ov-none-${Date.now()}`);
    const overview = await queries.getSpendingOverview(ownerAuth(userId, workspaceId));
    expect(overview.policy).toBeNull();
    expect(overview.remainingToday).toBeNull();
    expect(Number(overview.openReservedToday)).toBe(0);
    expect(Number(overview.settledToday)).toBe(0);
  });
});
