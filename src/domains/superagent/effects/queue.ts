/**
 * The effects queue's SQL-side mechanics, over the raw postgres client — the
 * same discipline the audit outbox's dispatcher uses. The engine never touches
 * these: producers enqueue through the store (inside the command's
 * transaction), and the drain pass claims and resolves rows outside any
 * transaction so a handler never runs while locks are held.
 */
import postgres from "postgres";
import type { EffectKind } from "../store/schema";

/** A raw postgres-js client, as the audit dispatcher takes; the drain passes span workspaces. */
export type RawClient = ReturnType<typeof postgres>;

const DEFAULT_BATCH = 20;
const DEFAULT_LEASE_MS = 60_000;
/** Where a handlerless kind, or a `Later`, parks until its next look. */
export const DEFAULT_PARK_MS = 60_000;

/** Raised when a queue write arrives for a lease the worker no longer holds. */
class EffectStaleWriteError extends Error {
  constructor(message = "The effect row moved on after its lease expired.") {
    super(message);
    this.name = "EffectStaleWriteError";
  }
}

/** One effect claimed by the drain pass. The payload is the producer's own untrusted data. */
export type ClaimedEffect = {
  id: string;
  workspaceId: string;
  kind: EffectKind;
  key: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  consecutiveFailures: number;
  leaseToken: string;
};

/** What a kind's consumer does with a claimed effect: the work, once. */
export type EffectHandler = (effect: ClaimedEffect) => Promise<void>;

/** One consumer per kind; absent kinds park without failure. */
export type EffectHandlers = Partial<Record<EffectKind, EffectHandler>>;

/**
 * Claims up to `limit` due effects for `workerId` under a fresh lease. The
 * transaction covers only the select+update — the handler never runs inside
 * it. `for update skip locked` lets overlapping passes share the queue, and
 * the optional workspace filter scopes the inline post-commit drain to the
 * workspace whose command just flushed.
 */
export async function claimDueEffects(
  rawClient: RawClient,
  input: { workerId: string; workspaceId?: string; limit?: number; leaseMs?: number },
): Promise<ClaimedEffect[]> {
  const limit = input.limit ?? DEFAULT_BATCH;
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const workspace = input.workspaceId ?? null;
  return rawClient.begin(async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from work_effects
      where status = 'pending'
        and available_at <= now()
        and (lease_expires_at is null or lease_expires_at <= now())
        and (${workspace}::text is null or workspace_id = ${workspace}::uuid)
      order by available_at
      limit ${limit}
      for update skip locked
    `;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const claimed = await tx<
      {
        id: string;
        workspace_id: string;
        kind: string;
        key: string;
        payload: Record<string, unknown> | null;
        attempts: number;
        consecutive_failures: number;
        lease_token: string;
      }[]
    >`
      update work_effects
      set lease_owner = ${input.workerId},
          lease_token = gen_random_uuid(),
          lease_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond')
      where id = any(${ids})
      returning id, workspace_id, kind, key, payload, attempts, consecutive_failures, lease_token::text
    `;
    return claimed.map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id,
      kind: row.kind as EffectKind,
      key: row.key,
      payload: row.payload,
      attempts: row.attempts,
      consecutiveFailures: row.consecutive_failures,
      leaseToken: row.lease_token,
    }));
  });
}

/** Marks a claimed effect done. A stale lease token is rejected, not silently dropped. */
export async function completeEffect(rawClient: RawClient, input: { id: string; leaseToken: string }): Promise<void> {
  const updated = await rawClient`
    update work_effects
    set status = 'done', done_at = now(),
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
    returning id
  `;
  if (updated.length === 0) throw new EffectStaleWriteError();
}

/**
 * Records a failed attempt: the counters grow, the row waits out its kind's
 * backoff, and the row stays pending — the queue never dead-letters. The
 * `consecutive_failures` count is what raises the health entry after three.
 */
export async function failEffect(
  rawClient: RawClient,
  input: { id: string; leaseToken: string; error: string; retryAt: Date },
): Promise<number> {
  const updated = await rawClient<{ consecutive_failures: number }[]>`
    update work_effects
    set attempts = attempts + 1,
        consecutive_failures = consecutive_failures + 1,
        last_error = ${input.error},
        available_at = ${input.retryAt.toISOString()}::timestamptz,
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
    returning consecutive_failures
  `;
  if (updated.length === 0) throw new EffectStaleWriteError();
  return updated[0]!.consecutive_failures;
}

/**
 * Releases one claim without spending a failure: a `Later` throw, or a kind
 * whose consumer has not deployed yet. The park time keeps a released row
 * from spinning — cleared alone, a lease would make the row immediately
 * claimable again at the speed of the loop.
 */
export async function deferEffect(
  rawClient: RawClient,
  input: { id: string; leaseToken: string; retryAt: Date },
): Promise<void> {
  await rawClient`
    update work_effects
    set available_at = ${input.retryAt.toISOString()}::timestamptz,
        lease_owner = null, lease_token = null, lease_expires_at = null
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'pending'
  `;
}

/**
 * The sweeper: releases leases whose worker died between claim and completion.
 * Failure counters are not touched — the work may never have run, so this is
 * a release, not a failure. Returns the released ids for the caller's metric.
 */
export async function recoverStrandedEffects(rawClient: RawClient): Promise<string[]> {
  const rows = await rawClient<{ id: string }[]>`
    update work_effects
    set lease_owner = null, lease_token = null, lease_expires_at = null
    where status = 'pending' and lease_owner is not null and lease_expires_at <= now()
    returning id
  `;
  return rows.map((row) => row.id);
}
