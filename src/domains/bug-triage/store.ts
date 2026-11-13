import { and, asc, desc, eq, gt, gte, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { bugSignals } from "./schema";
import { scrubText } from "./scrub";
import type { BugSignal } from "./signal";

/*
 * The bug agent's persistence. Two invariants live here:
 *
 * - Dedupe: one row per fingerprint, enforced by the unique index, so a burst
 *   of the same error from many tabs is one row with a count, never a race.
 * - Daily cap: at most `cap` issues are filed per UTC day. Claims count both
 *   filed rows and in-flight leases under one advisory lock, so two workers
 *   cannot each see room for the last slot.
 */

const LEASE_MS = 2 * 60_000;
const RETRY_MS = 15 * 60_000;
/** Arbitrary but fixed: the advisory lock key for the cap check. */
const CAP_LOCK_KEY = 7_401_221;

/** Record a sighting. Returns whether it was new. */
export async function recordBugSignal(signal: BugSignal, now = new Date()): Promise<{ created: boolean }> {
  const [row] = await db
    .insert(bugSignals)
    .values({ fingerprint: signal.fingerprint, signal, firstSeenAt: now, lastSeenAt: now })
    .onConflictDoUpdate({
      target: bugSignals.fingerprint,
      set: {
        occurrences: sql`${bugSignals.occurrences} + 1`,
        lastSeenAt: now,
        signal,
      },
    })
    .returning({ occurrences: bugSignals.occurrences });
  return { created: row.occurrences === 1 };
}

export type ClaimedSignal = {
  id: string;
  signal: BugSignal;
  occurrences: number;
  firstSeenAt: Date;
};

function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Lease the unfiled signals that fit under today's cap, most-seen first.
 * Returns an empty list when the cap is spent; the rest wait for tomorrow.
 */
export async function claimSignalsToFile(cap: number, now = new Date()): Promise<ClaimedSignal[]> {
  return withTransaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CAP_LOCK_KEY})`);
    const [{ used }] = await tx
      .select({ used: sql<number>`count(*)::int` })
      .from(bugSignals)
      .where(or(gte(bugSignals.filedAt, startOfUtcDay(now)), gt(bugSignals.leaseExpiresAt, now)));
    const room = cap - used;
    if (room <= 0) return [];

    const due = await tx
      .select({ id: bugSignals.id })
      .from(bugSignals)
      .where(
        and(
          isNull(bugSignals.issueNumber),
          or(isNull(bugSignals.leaseExpiresAt), lte(bugSignals.leaseExpiresAt, now)),
          or(isNull(bugSignals.retryAt), lte(bugSignals.retryAt, now)),
        ),
      )
      .orderBy(desc(bugSignals.occurrences), asc(bugSignals.firstSeenAt), asc(bugSignals.id))
      .limit(room);
    if (due.length === 0) return [];

    const claimed: ClaimedSignal[] = [];
    for (const { id } of due) {
      const [row] = await tx
        .update(bugSignals)
        .set({ leaseExpiresAt: new Date(now.getTime() + LEASE_MS), attempts: sql`${bugSignals.attempts} + 1` })
        .where(eq(bugSignals.id, id))
        .returning({
          id: bugSignals.id,
          signal: bugSignals.signal,
          occurrences: bugSignals.occurrences,
          firstSeenAt: bugSignals.firstSeenAt,
        });
      claimed.push(row);
    }
    return claimed;
  });
}

export async function markSignalFiled(id: string, issueNumber: number, now = new Date()): Promise<void> {
  await db
    .update(bugSignals)
    .set({ issueNumber, filedAt: now, leaseExpiresAt: null, retryAt: null, lastError: null })
    .where(eq(bugSignals.id, id));
}

/** A failed attempt: release the lease and wait before the next one. The error text is scrubbed. */
export async function releaseSignal(id: string, error: string, now = new Date()): Promise<void> {
  await db
    .update(bugSignals)
    .set({ leaseExpiresAt: null, retryAt: new Date(now.getTime() + RETRY_MS), lastError: scrubText(error) })
    .where(eq(bugSignals.id, id));
}
