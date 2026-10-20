import type postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { AuthContext } from "@/domains/identity/resolve";
import type { TxDrizzle } from "@/lib/db-transaction";
import { outboxEvents } from "./schema";

/*
 * The outbox dispatcher (ASH-134 Q03). Producers already write outbox rows in
 * the same transaction as the change they describe; this module is the other
 * half: claim pending rows under a short lease, run the handler outside any
 * transaction, then record the outcome. The invariants it proves:
 *
 * - Commit-before-publish crash: the row is still pending; the sweeper or the
 *   next claim picks it up. Intent is never lost once committed.
 * - Accepted publish, lost response: the row stays pending (or its lease
 *   expires and recoverStrandedOutbox releases it), so the handler runs again.
 *   Handlers must be idempotent on the event id - delivery is at-least-once.
 * - Stale completion: a worker that lost its lease (expired, reclaimed by a
 *   restart) cannot complete or fail the row; the lease token fences it.
 * - Dead letters: after MAX_ATTEMPTS the row goes dead with the last error,
 *   never silently retried forever.
 *
 * Claim/complete/recover take the raw postgres-js client, not AuthContext:
 * the dispatcher runs outside any request and spans every workspace, same
 * shape as reconcileStaleRuns. enqueueOutbox is the producer side and stays
 * in the caller's drizzle transaction.
 */

export class OutboxStaleWriteError extends Error {
  constructor(message = "The outbox row is leased to another worker or already resolved.") {
    super(message);
    this.name = "OutboxStaleWriteError";
  }
}

export const OUTBOX_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH = 10;

/** Full-jitter exponential backoff, capped. `random` injectable for tests. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const cap = 60_000;
  const ceiling = Math.min(cap, 1000 * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export type ClaimedOutboxEvent = {
  id: string;
  workspaceId: string;
  topic: string;
  payload: unknown;
  attempts: number;
  leaseToken: string;
};

/** Producer side, inside the caller's transaction. A repeated dispatchKey enqueues nothing. */
export async function enqueueOutbox(
  tx: TxDrizzle,
  auth: Pick<AuthContext, "workspaceId">,
  input: { topic: string; payload: unknown; dispatchKey?: string; availableAt?: Date },
): Promise<{ enqueued: boolean; id: string | null }> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({
      workspaceId: auth.workspaceId,
      topic: input.topic,
      payload: input.payload,
      dispatchKey: input.dispatchKey ?? null,
      availableAt: input.availableAt ?? new Date(),
    })
    .onConflictDoNothing({
      target: [outboxEvents.workspaceId, outboxEvents.topic, outboxEvents.dispatchKey],
      where: sql`dispatch_key is not null`,
    })
    .returning({ id: outboxEvents.id });
  return { enqueued: Boolean(row), id: row?.id ?? null };
}

/**
 * Claims up to `limit` due rows for `workerId` under a fresh lease. The
 * transaction covers only the select+update - the handler never runs inside
 * it. `for update skip locked` lets overlapping dispatchers share the queue.
 */
export async function claimOutboxBatch(
  rawClient: ReturnType<typeof postgres>,
  input: { workerId: string; limit?: number; leaseMs?: number },
): Promise<ClaimedOutboxEvent[]> {
  const limit = input.limit ?? DEFAULT_BATCH;
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  return rawClient.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from outbox_events
      where status = 'pending' and available_at <= now()
        and (lease_expires_at is null or lease_expires_at <= now())
      order by available_at
      limit ${limit}
      for update skip locked
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const claimed = await tx<
      { id: string; workspace_id: string; topic: string; payload: unknown; attempts: number; lease_token: string }[]
    >`
      update outbox_events
      set lease_owner = ${input.workerId},
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond')
      where id = any(${ids})
      returning id, workspace_id, topic, payload, attempts, lease_token::text
    `;
    return claimed.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      topic: row.topic,
      payload: row.payload,
      attempts: row.attempts,
      leaseToken: row.lease_token,
    }));
  });
}

/** Marks a claimed row dispatched. A stale lease token is rejected, not silently dropped. */
export async function completeOutbox(
  rawClient: ReturnType<typeof postgres>,
  input: { id: string; leaseToken: string },
): Promise<void> {
  const updated = await rawClient`
    update outbox_events
    set status = 'dispatched', dispatched_at = now(),
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
    returning id
  `;
  if (updated.length === 0) throw new OutboxStaleWriteError();
}

/** Records a failed attempt: back off and retry, or dead-letter at the ceiling. */
export async function failOutbox(
  rawClient: ReturnType<typeof postgres>,
  input: { id: string; leaseToken: string; error: string; retryAt?: Date },
): Promise<{ dead: boolean }> {
  return rawClient.begin(async (tx) => {
    const [row] = await tx<{ attempts: number }[]>`
      update outbox_events
      set attempts = attempts + 1,
          last_error = ${input.error},
          lease_owner = null, lease_token = null, lease_expires_at = null
      where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
      returning attempts
    `;
    if (!row) throw new OutboxStaleWriteError();
    const dead = row.attempts >= OUTBOX_MAX_ATTEMPTS;
    await tx`
      update outbox_events
      set status = ${dead ? "dead" : "pending"}::outbox_status,
          available_at = ${(input.retryAt ?? new Date()).toISOString()}::timestamptz
      where id = ${input.id}
    `;
    return { dead };
  });
}

/**
 * The sweeper: releases leases whose worker died between claim and completion.
 * Attempts are not incremented - the work may never have run, so this is a
 * release, not a failure. Returns the released ids for the caller's metric.
 */
export async function recoverStrandedOutbox(rawClient: ReturnType<typeof postgres>): Promise<string[]> {
  const rows = await rawClient<{ id: string }[]>`
    update outbox_events
    set lease_owner = null, lease_token = null, lease_expires_at = null
    where status = 'pending' and lease_owner is not null and lease_expires_at <= now()
    returning id
  `;
  return rows.map((row) => row.id);
}

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;

/**
 * Releases one claim without spending an attempt: no consumer for the topic
 * yet, or a long-running job that is not terminal and must be looked at again.
 *
 * `availableAt` matters. Clearing the lease alone makes the row immediately
 * claimable again, so a handler that releases a still-running crawl would spin
 * at the speed of the loop. Passing a future time parks it instead.
 */
export async function releaseOutbox(
  rawClient: ReturnType<typeof postgres>,
  input: { id: string; leaseToken: string; availableAt?: Date },
): Promise<void> {
  await rawClient`
    update outbox_events
    set lease_owner = null, lease_token = null, lease_expires_at = null,
        available_at = coalesce(${input.availableAt ? input.availableAt.toISOString() : null}::timestamptz, available_at)
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
  `;
}

/*
 * A handler that throws this is saying "the provider was unreachable, not the
 * work was wrong". The dispatcher parks the row and does not spend an attempt,
 * so five minutes of a stopped Firecrawl cannot dead-letter a crawl that never
 * ran. The row is still visible as pending and overdue, which is the point.
 */
export class OutboxDeferredError extends Error {
  constructor(message: string, readonly retryAfterMs = 60_000) {
    super(message);
    this.name = "OutboxDeferredError";
  }
}

/*
 * A handler that throws this is saying "long job still running; look again
 * later". Same effect as returning, but it parks the row instead of completing
 * it, and it spends no attempt - a crawl that polls forty times is one attempt,
 * not forty.
 */
export class OutboxParkedError extends Error {
  constructor(readonly retryAfterMs: number, message = "work is still running") {
    super(message);
    this.name = "OutboxParkedError";
  }
}

/**
 * A handler's only legal mid-flight write: update its own payload while it
 * still holds the lease. A crawl needs this to remember the provider job id
 * between passes. Fenced by the lease token, so a worker that lost the row
 * cannot resurrect it by writing into the update.
 */
export async function updateOutboxPayload(
  rawClient: ReturnType<typeof postgres>,
  input: { id: string; leaseToken: string; payload: unknown },
): Promise<void> {
  // Written through drizzle so the jsonb column does the encoding. Casting a
  // string parameter to ::jsonb instead stores a jsonb *string*, and the next
  // handler pass then reads no fields at all - a crawl would silently dispatch
  // having done nothing. The update stays fenced by the lease token, so a
  // worker that lost the row cannot resurrect it.
  await db
    .update(outboxEvents)
    .set({ payload: input.payload })
    .where(
      and(
        eq(outboxEvents.id, input.id),
        eq(outboxEvents.leaseToken, input.leaseToken),
        eq(outboxEvents.status, "pending"),
      ),
    );
}

/**
 * One dispatcher pass: claim a batch, run each handler outside any
 * transaction, record the outcome. A handler that throws is a failed attempt
 * with backoff; a process that dies mid-pass leaves leases the sweeper
 * releases. Handlers see every redelivery - they dedupe on the event id.
 */
export async function dispatchPendingOutbox(
  rawClient: ReturnType<typeof postgres>,
  handlers: Record<string, OutboxHandler>,
  input: { workerId: string; limit?: number; leaseMs?: number },
): Promise<{ claimed: number; dispatched: number; failed: number; dead: number; deferred: number; parked: number }> {
  const batch = await claimOutboxBatch(rawClient, input);
  let dispatched = 0;
  let failed = 0;
  let dead = 0;
  let deferred = 0;
  let parked = 0;
  for (const event of batch) {
    const handler = handlers[event.topic];
    if (!handler) {
      // No consumer for this topic yet: release the lease without spending an
      // attempt, so a deploy order (producer before consumer) never dead-letters
      // intent. Parked for a minute rather than released into the next claim,
      // otherwise every tick re-claims the same handlerless row forever.
      await releaseOutbox(rawClient, {
        id: event.id,
        leaseToken: event.leaseToken,
        availableAt: new Date(Date.now() + 60_000),
      });
      continue;
    }
    try {
      await handler(event);
      await completeOutbox(rawClient, { id: event.id, leaseToken: event.leaseToken });
      dispatched += 1;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof OutboxDeferredError || cause instanceof OutboxParkedError) {
        // Still running, or the provider is unreachable: park the row without
        // spending an attempt. The distinction is only in the counters.
        await releaseOutbox(rawClient, {
          id: event.id,
          leaseToken: event.leaseToken,
          availableAt: new Date(Date.now() + cause.retryAfterMs),
        });
        if (cause instanceof OutboxDeferredError) deferred += 1;
        else parked += 1;
        continue;
      }
      const retryAt = new Date(Date.now() + backoffMs(event.attempts + 1));
      const outcome = await failOutbox(rawClient, { id: event.id, leaseToken: event.leaseToken, error: message, retryAt });
      failed += 1;
      if (outcome.dead) dead += 1;
    }
  }
  return { claimed: batch.length, dispatched, failed, dead, deferred, parked };
}
