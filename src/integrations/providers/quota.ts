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
   * bucket for the period if needed. Returns the bucket id, or null when the
   * reservation would exceed the allowance (the caller's hard stop).
   */
  reserve(key: QuotaKey, units: number, allowance: number, unit: string): Promise<{ bucketId: string } | null>;
  /** Move units from reserved to consumed after the call. */
  settle(bucketId: string, held: number, actual: number): Promise<void>;
  /** Return held units after a failed call. */
  release(bucketId: string, held: number): Promise<void>;
}

/*
 * The period key for an allowance. Monthly allowances use the UTC calendar
 * month (Firecrawl refreshes monthly; the account's exact billing anchor is
 * not exposed). Daily allowances use the Pacific date, because the one daily
 * quota we enforce (Gemini's RPD) resets at midnight Pacific.
 */
export function currentPeriod(renewal: "daily" | "monthly", now: Date = new Date()): string {
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
      const rows = await database.execute(sql`
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
      await database.execute(sql`
        INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units)
        VALUES (${key.workspaceId}::uuid, ${row.id}::uuid, 'reserve', ${units})
      `);
      return { bucketId: row.id };
    },
    async settle(bucketId, held, actual) {
      await database.execute(sql`
        UPDATE provider_quota_buckets
        SET consumed = consumed + ${actual},
            reserved = greatest(reserved - ${held}, 0),
            updated_at = now()
        WHERE id = ${bucketId}::uuid
      `);
      await database.execute(sql`
        INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units)
        SELECT workspace_id, id, 'settle', ${actual} FROM provider_quota_buckets WHERE id = ${bucketId}::uuid
      `);
    },
    async release(bucketId, held) {
      await database.execute(sql`
        UPDATE provider_quota_buckets
        SET reserved = greatest(reserved - ${held}, 0), updated_at = now()
        WHERE id = ${bucketId}::uuid
      `);
      await database.execute(sql`
        INSERT INTO provider_usage_ledger (workspace_id, bucket_id, kind, units)
        SELECT workspace_id, id, 'release', ${held} FROM provider_quota_buckets WHERE id = ${bucketId}::uuid
      `);
    },
  };
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
    await store.settle(reservation.bucketId, estimate, actualOf ? actualOf(result) : estimate);
    return result;
  } catch (cause) {
    await store.release(reservation.bucketId, estimate);
    throw cause;
  }
}
