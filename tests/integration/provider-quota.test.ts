import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestDb, seedWorkspace } from "../helpers/test-workspace";

/*
 * The quota ledger's hard invariant lives in Postgres, not in the flow logic
 * the unit suite proves: concurrent reservations must never over-draw a free
 * allowance. The reserve path is one INSERT ... ON CONFLICT ... WHERE
 * consumed + reserved + new <= allowance, and only a real database can show
 * the conflict target holding the line when two runs race the same bucket.
 *
 * Skipped locally without TEST_DATABASE_URL; in CI the missing database is a
 * broken gate and throws (see tests/helpers/test-workspace.ts).
 */

const handle = makeTestDb();
const suite = handle ? describe : describe.skip;
let db: NonNullable<typeof handle>["db"];
let quota: typeof import("@/integrations/providers/quota");
let registry: typeof import("@/integrations/providers/registry");

beforeAll(async () => {
  if (!handle) return;
  ({ db } = handle);
  quota = await import("@/integrations/providers/quota");
  registry = await import("@/integrations/providers/registry");
});

afterAll(async () => {
  await handle?.client.end();
});

suite("drizzleQuotaStore", () => {
  it("creates the bucket lazily, settles, and reports the remaining allowance", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-basic-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const r1 = await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-01" }, 2, 1000, "credits");
    expect(r1).not.toBeNull();
    await store.settle(r1!.bucketId, r1!.reservationId, 2, 2);
    const rows = await db.execute(sql`
      SELECT reserved, consumed, allowance FROM provider_quota_buckets
      WHERE workspace_id = ${workspaceId}::uuid AND provider = 'firecrawl' AND period = '2099-01'
    `);
    expect((rows as unknown as Array<{ reserved: number; consumed: number; allowance: number }>)[0]).toMatchObject({
      reserved: 0,
      consumed: 2,
      allowance: 1000,
    });
    const ledger = await db.execute(sql`
      SELECT kind, units FROM provider_usage_ledger WHERE bucket_id = ${r1!.bucketId}::uuid ORDER BY created_at, kind
    `);
    expect((ledger as unknown as Array<{ kind: string }>).map((l) => l.kind)).toEqual(["reserve", "settle"]);
  });

  it("refuses the reservation that would cross the allowance, under concurrency", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-race-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const key = { workspaceId, provider: "gemini", period: "2099-01-15" };
    // Ten racers for a cap of 5, one unit each: exactly five may land.
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, () => store.reserve(key, 1, 5, "requests")),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(5);
    expect(outcomes.filter((o) => o === null)).toHaveLength(5);
    // And once full, it stays full: the eleventh is refused too.
    expect(await store.reserve(key, 1, 5, "requests")).toBeNull();
  });

  it("a released reservation frees the units for the next attempt", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-release-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const key = { workspaceId, provider: "firecrawl", period: "2099-02" };
    const r = await store.reserve(key, 4, 4, "credits");
    expect(r).not.toBeNull();
    expect(await store.reserve(key, 1, 4, "credits")).toBeNull();
    await store.release(r!.bucketId, r!.reservationId, 4);
    expect(await store.reserve(key, 1, 4, "credits")).not.toBeNull();
  });

  it("a replayed settle settles exactly once, so a transport retry cannot double-count", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-replay-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const r = await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-03" }, 2, 1000, "credits");
    expect(r).not.toBeNull();
    await store.settle(r!.bucketId, r!.reservationId, 2, 2);
    await store.settle(r!.bucketId, r!.reservationId, 2, 2);
    await store.settle(r!.bucketId, r!.reservationId, 2, 2);
    const rows = await db.execute(sql`
      SELECT consumed, reserved FROM provider_quota_buckets WHERE id = ${r!.bucketId}::uuid
    `);
    expect((rows as unknown as Array<{ consumed: number; reserved: number }>)[0]).toMatchObject({
      consumed: 2,
      reserved: 0,
    });
  });

  it("a settle arriving after a release claims nothing — one finalize per reservation", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-xor-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const r = await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-04" }, 2, 1000, "credits");
    expect(r).not.toBeNull();
    await store.release(r!.bucketId, r!.reservationId, 2);
    await store.settle(r!.bucketId, r!.reservationId, 2, 2);
    const rows = await db.execute(sql`
      SELECT consumed, reserved FROM provider_quota_buckets WHERE id = ${r!.bucketId}::uuid
    `);
    // The release won the claim; the late settle is a no-op, not a charge.
    expect((rows as unknown as Array<{ consumed: number; reserved: number }>)[0]).toMatchObject({
      consumed: 0,
      reserved: 0,
    });
  });

  it("withQuota turns the refusal into QuotaExhaustedError and never runs the work", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-exhaust-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const entry = {
      ...registry!.providerEntry("firecrawl")!,
      quota: { unit: "credits" as const, allowance: 1, renewal: "monthly" as const },
    };
    let calls = 0;
    await quota!.withQuota(store, entry, workspaceId, 1, async () => {
      calls++;
      return "ok";
    });
    await expect(
      quota!.withQuota(store, entry, workspaceId, 1, async () => {
        calls++;
        return "never";
      }),
    ).rejects.toThrow(quota!.QuotaExhaustedError);
    expect(calls).toBe(1);
  });

  it("the reaper returns a stranded reservation to the bucket and a late settle stays a no-op", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-reap-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const r = await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-05" }, 3, 1000, "credits");
    expect(r).not.toBeNull();
    // Simulate a process that died between reserve and settle: backdate the
    // reserve's ledger row past the reaper's cutoff.
    await db.execute(sql`
      UPDATE provider_usage_ledger SET created_at = now() - interval '3 hours'
      WHERE bucket_id = ${r!.bucketId}::uuid AND kind = 'reserve'
    `);
    const reaped = await quota!.reapStaleReservations(60 * 60 * 1000);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const rows = await db.execute(sql`
      SELECT reserved, consumed FROM provider_quota_buckets WHERE id = ${r!.bucketId}::uuid
    `);
    expect((rows as unknown as Array<{ reserved: number; consumed: number }>)[0]).toMatchObject({
      reserved: 0,
      consumed: 0,
    });
    // The reservation is reusable.
    expect(await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-05" }, 3, 1000, "credits")).not.toBeNull();
    // And a late settle for the reaped reservation cannot double-apply.
    await store.settle(r!.bucketId, r!.reservationId, 3, 3);
    const after = await db.execute(sql`
      SELECT consumed FROM provider_quota_buckets WHERE id = ${r!.bucketId}::uuid
    `);
    expect((after as unknown as Array<{ consumed: number }>)[0].consumed).toBe(0);
  });

  it("the reaper leaves a fresh reservation alone", async () => {
    const { workspaceId } = await seedWorkspace(db, `quota-reap-fresh-${Date.now()}`);
    const store = quota!.drizzleQuotaStore(db);
    const r = await store.reserve({ workspaceId, provider: "firecrawl", period: "2099-06" }, 3, 1000, "credits");
    expect(r).not.toBeNull();
    expect(await quota!.reapStaleReservations(60 * 60 * 1000)).toBe(0);
    const rows = await db.execute(sql`
      SELECT reserved FROM provider_quota_buckets WHERE id = ${r!.bucketId}::uuid
    `);
    expect((rows as unknown as Array<{ reserved: number }>)[0].reserved).toBe(3);
  });
});
