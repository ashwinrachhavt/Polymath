import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { quotaAllowance, type ProviderEntry } from "./registry";

/*
 * The shared quota ledger (ASH-187, the GA09 budget slice of ADR 0006).
 * Admission order is always: reserve units atomically -> execute the provider
 * call -> settle the actual units (or release the reservation on failure).
 * A transaction never spans a provider call, matching db-transaction.ts.
 *
 * The hard stop is the whole point: when consumed + reserved reaches the
 * allowance the reservation comes back empty and the caller gets
 * QuotaExhaustedError. There is no paid fallback, no recharge, no queue —
 * the work surfaces "free allowance exhausted" and stops.
 *
 * The store is an interface so the reservation flow is unit-testable without
 * Postgres; the drizzle store holds the real invariants, and the integration
 * suite proves them against the service database.
 */

export class QuotaExhaustedError extends Error {
  constructor(
    readonly provider: string,
    readonly period: string,
    readonly allowance: number,
  ) {
    super(`Free allowance exhausted for ${provider} (${period}, cap ${allowance}). No paid fallback: the work stops here.`);
    this.name = "QuotaExhaustedError";
  }
}

export type QuotaKey = {
  workspaceId: string;
  provider: string;
  period: string;
};

export interface QuotaStore {
  /**
   * Atomically add `units` to the bucket's reserved counter, creating the
   * bucket for the period if needed. Returns the bucket id plus the
   * reservation ref that finalizes key off, or null when the reservation
   * would exceed the allowance (the caller's hard stop).
   */
  reserve(
    key: QuotaKey,
    units: number,
    allowance: number,
    unit: string,
  ): Promise<{ bucketId: string; reservationId: string } | null>;
  /**
   * Move units from reserved to consumed after the call. Keyed by the
   * reservation ref: a replayed settle (or a settle racing a release or the
   * reaper) is a no-op — at most one finalize ever claims a reservation.
   */
  settle(bucketId: string, reservationId: string, held: number, actual: number): Promise<void>;
  /** Return held units after a failed call. Same once-per-reservation rule. */
  release(bucketId: string, reservationId: string, held: number): Promise<void>;
}

/*
 * The period key for an allowance. Monthly allowances use the UTC calendar
 * month (Firecrawl refreshes monthly; the account's exact billing anchor is
 * not exposed). Daily allowances use the Pacific date, because the one daily
 * quota we enforce (Gemini's RPD) resets at midnight Pacific. A lifetime
 * allowance is a one-time grant: one bucket that never rolls over, so an
 * exhausted grant stays exhausted rather than re-admitting on a date change.
 */
export function currentPeriod(renewal: "daily" | "monthly" | "lifetime", now: Date = new Date()): string {
  if (renewal === "lifetime") return "lifetime";
  if (renewal === "monthly") {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const pacific = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return `${pacific.getFullYear()}-${String(pacific.getMonth() + 1).padStart(2, "0")}-${String(pacific.getDate()).padStart(2, "0")}`;
}

/** The Postgres store: one UPSERT...WHERE reserves atomically under contention. */
export function drizzleQuotaStore(database: typeof db = db): QuotaStore {
  return {
    async reserve(key, units, allowance, unit) {
      if (units <= 0) throw new Error("reserve needs at least one unit");
      if (units > allowance) return null;
      // The ref mints before the transaction so a connection drop after the
      // upsert cannot leave the bucket incremented with no ledger row: counter
      // and evidence commit together or not at all.
      const reservationId = crypto.randomUUID();
      return database.transaction(async (tx) => {
        const rows = await tx.execute(sql`
          INSERT INTO provider_quota_buckets (workspace_id, provider, period, unit, allowance, reserved)
          VALUES (${key.workspaceId}::uuid, ${key.provider}, ${key.period}, ${unit}, ${allowance}, ${units})
          ON CONFLICT (workspace_id, provider, period) DO UPDATE
            SET reserved = provider_quota_buckets.reserved + EXCLUDED.reserved,
                allowance = EXCLUDED.allowance,
                updated_at = now()
            WHERE provider_quota_buckets.consumed + provider_quota_buckets.reserved + EXCLUDED.reserved
                  <= provider_quota_buckets.allowance
          RETURNING id
        `);
        const row = (rows as unknown as Array<{ id: string }>)[0];
        if (!row) return null;
        await tx.execute(sql`
          INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units, reservation_ref)
          VALUES (${key.workspaceId}::uuid, ${row.id}::uuid, 'reserve', ${units}, ${reservationId}::uuid)
        `);
        return { bucketId: row.id, reservationId };
      });
    },
    async settle(bucketId, reservationId, held, actual) {
      await database.transaction(async (tx) => {
        // Claim first: the partial unique index on (bucket_id, reservation_ref)
        // over finalize rows lets exactly one settle/release/reaper per
        // reservation past the claim, so a retried settle cannot double-count.
        const claimed = await tx.execute(sql`
          INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units, reservation_ref)
          SELECT workspace_id, id, 'settle', ${actual}, ${reservationId}::uuid
          FROM provider_quota_buckets WHERE id = ${bucketId}::uuid
          ON CONFLICT (bucket_id, reservation_ref) WHERE kind in ('settle', 'release') DO NOTHING
          RETURNING id
        `);
        if ((claimed as unknown as Array<unknown>).length === 0) return;
        await tx.execute(sql`
          UPDATE provider_quota_buckets
          SET consumed = consumed + ${actual},
              reserved = greatest(reserved - ${held}, 0),
              updated_at = now()
          WHERE id = ${bucketId}::uuid
        `);
      });
    },
    async release(bucketId, reservationId, held) {
      await database.transaction(async (tx) => {
        const claimed = await tx.execute(sql`
          INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units, reservation_ref)
          SELECT workspace_id, id, 'release', ${held}, ${reservationId}::uuid
          FROM provider_quota_buckets WHERE id = ${bucketId}::uuid
          ON CONFLICT (bucket_id, reservation_ref) WHERE kind in ('settle', 'release') DO NOTHING
          RETURNING id
        `);
        if ((claimed as unknown as Array<unknown>).length === 0) return;
        await tx.execute(sql`
          UPDATE provider_quota_buckets
          SET reserved = greatest(reserved - ${held}, 0), updated_at = now()
          WHERE id = ${bucketId}::uuid
        `);
      });
    },
  };
}

/**
 * Reclaim reservations whose call never came back: a reserve ledger row with
 * no settle/release sibling after `olderThanMs` is a dead process's held
 * units, and the reaper returns them to the bucket. Finalizing through the
 * same claimed release as everyone else keeps it safe against a late settle
 * (one of the two wins the claim) and against its own retries. Legacy rows
 * minted before reservation refs existed carry no ref and are left alone —
 * they cannot be finalized idempotently. Wired into the daily cron.
 */
export async function reapStaleReservations(olderThanMs = 60 * 60 * 1000): Promise<number> {
  const stale = await db.execute(sql`
    SELECT r.bucket_id, r.reservation_ref, r.units
    FROM provider_usage_ledger r
    WHERE r.kind = 'reserve'
      AND r.reservation_ref IS NOT NULL
      AND r.created_at < now() - make_interval(secs => ${olderThanMs / 1000})
      AND NOT EXISTS (
        SELECT 1 FROM provider_usage_ledger f
        WHERE f.bucket_id = r.bucket_id
          AND f.reservation_ref = r.reservation_ref
          AND f.kind IN ('settle', 'release')
      )
    LIMIT 100
  `);
  const store = drizzleQuotaStore();
  let reaped = 0;
  for (const row of stale as unknown as Array<{ bucket_id: string; reservation_ref: string; units: number }>) {
    await store.release(row.bucket_id, row.reservation_ref, row.units);
    reaped++;
  }
  return reaped;
}

/**
 * Reserve `estimate` units of the entry's quota, run `fn`, then settle with
 * the actual units consumed (default: the estimate). A throw releases the
 * reservation so a failed provider call does not burn the free allowance.
 */
export async function withQuota<T>(
  store: QuotaStore,
  entry: ProviderEntry,
  workspaceId: string,
  estimate: number,
  fn: () => Promise<T>,
  actualOf?: (result: T) => number,
  env: Record<string, string | undefined> = process.env,
): Promise<T> {
  const allowance = quotaAllowance(entry, env);
  if (!entry.quota || allowance === null || estimate <= 0) return fn();
  const period = currentPeriod(entry.quota.renewal);
  const reservation = await store.reserve(
    { workspaceId, provider: entry.id, period },
    estimate,
    allowance,
    entry.quota.unit,
  );
  if (!reservation) throw new QuotaExhaustedError(entry.id, period, allowance);
  try {
    const result = await fn();
    await store.settle(reservation.bucketId, reservation.reservationId, estimate, actualOf ? actualOf(result) : estimate);
    return result;
  } catch (cause) {
    await store.release(reservation.bucketId, reservation.reservationId, estimate);
    throw cause;
  }
}
