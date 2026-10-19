import type postgres from "postgres";

/*
 * ASH-134 Q04: canonical job + attempt persistence. Raw-client functions in
 * the outbox's shape (a worker spans workspaces and runs outside any request).
 * Invariants: one claim wins (FOR UPDATE SKIP LOCKED + conditional update),
 * every claim bumps `generation` and opens an attempt row, and every
 * heartbeat/finish names the lease token so a stale worker is rejected.
 * Nothing calls this from a request path yet.
 */

type Client = ReturnType<typeof postgres>;

export class JobStaleWriteError extends Error {
  constructor(message = "The job lease was lost, expired, or the job is already resolved.") {
    super(message);
    this.name = "JobStaleWriteError";
  }
}

export type ClaimedJob = {
  id: string;
  workspaceId: string;
  kind: string;
  input: unknown;
  attempt: number;
  generation: number;
  leaseToken: string;
  cancelRequested: boolean;
};

const DEFAULT_LEASE_MS = 60_000;

export async function enqueueJob(
  client: Client,
  input: { workspaceId: string; kind: string; input: unknown; dedupeKey?: string; priority?: number; maxAttempts?: number; availableAt?: Date; createdBy?: string },
): Promise<{ enqueued: boolean; id: string }> {
  const [row] = await client<{ id: string }[]>`
    insert into jobs (workspace_id, kind, input, dedupe_key, priority, max_attempts, available_at, created_by, updated_by)
    values (${input.workspaceId}, ${input.kind}, ${client.json(input.input as never)}, ${input.dedupeKey ?? null},
            ${input.priority ?? 0}, ${input.maxAttempts ?? 5}, ${(input.availableAt ?? new Date()).toISOString()}::timestamptz,
            ${input.createdBy ?? null}, ${input.createdBy ?? null})
    on conflict (workspace_id, kind, dedupe_key) where dedupe_key is not null do nothing
    returning id
  `;
  if (row) return { enqueued: true, id: row.id };
  const [existing] = await client<{ id: string }[]>`
    select id from jobs where workspace_id = ${input.workspaceId} and kind = ${input.kind} and dedupe_key = ${input.dedupeKey ?? null}
  `;
  return { enqueued: false, id: existing.id };
}

/** Claims the best due job (priority, then age) for `kinds`, or null. Opens the attempt row. */
export async function claimJob(
  client: Client,
  input: { workerId: string; kinds: string[]; leaseMs?: number },
): Promise<ClaimedJob | null> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  return client.begin(async (tx) => {
    const [pick] = await tx<{ id: string }[]>`
      select id from jobs
      where status = 'queued' and available_at <= now() and kind = any(${input.kinds})
        and cancel_requested_at is null
      order by priority desc, available_at
      limit 1
      for update skip locked
    `;
    if (!pick) return null;
    const [job] = await tx<
      { id: string; workspace_id: string; kind: string; input: unknown; attempts: number; generation: number; lease_token: string }[]
    >`
      update jobs
      set status = 'running', attempts = attempts + 1, generation = generation + 1,
          lease_owner = ${input.workerId}, lease_token = gen_random_uuid(),
          lease_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond'),
          heartbeat_at = now(), updated_at = now(), version = version + 1
      where id = ${pick.id}
      returning id, workspace_id, kind, input, attempts, generation, lease_token::text
    `;
    await tx`
      insert into job_attempts (workspace_id, job_id, generation, worker)
      values (${job.workspace_id}, ${job.id}, ${job.generation}, ${input.workerId})
    `;
    return {
      id: job.id,
      workspaceId: job.workspace_id,
      kind: job.kind,
      input: job.input,
      attempt: job.attempts,
      generation: job.generation,
      leaseToken: job.lease_token,
      cancelRequested: false,
    };
  });
}

/** Extends the lease. Returns whether cancellation was requested, so a worker can stop cooperatively. */
export async function heartbeatJob(
  client: Client,
  input: { id: string; leaseToken: string; leaseMs?: number },
): Promise<{ cancelRequested: boolean }> {
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const [row] = await client<{ cancel: boolean }[]>`
    update jobs
    set heartbeat_at = now(), lease_expires_at = now() + (${leaseMs}::double precision * interval '1 millisecond')
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'running'
    returning (cancel_requested_at is not null) as cancel
  `;
  if (!row) throw new JobStaleWriteError();
  return { cancelRequested: row.cancel };
}

async function finish(
  client: Client,
  input: { id: string; leaseToken: string },
  status: "succeeded" | "failed" | "cancelled" | "unknown" | "queued",
  extra: { result?: unknown; error?: string; retryAt?: Date },
): Promise<void> {
  const outcome = status === "queued" ? "failed" : status;
  const retryAt = extra.retryAt ? extra.retryAt.toISOString() : null;
  const result = extra.result === undefined ? null : client.json(extra.result as never);
  await client.begin(async (tx) => {
    const [row] = await tx<{ generation: number }[]>`
      update jobs
      set status = ${status},
          result = ${result},
          last_error = ${extra.error ?? null},
          available_at = coalesce(${retryAt}::timestamptz, available_at),
          finished_at = case when ${status} = 'queued' then null else now() end,
          lease_owner = null, lease_token = null, lease_expires_at = null,
          updated_at = now(), version = version + 1
      where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'running'
      returning generation
    `;
    if (!row) throw new JobStaleWriteError();
    await tx`
      update job_attempts set ended_at = now(), outcome = ${outcome}, error = ${extra.error ?? null}
      where job_id = ${input.id} and generation = ${row.generation}
    `;
  });
}

export async function completeJob(client: Client, input: { id: string; leaseToken: string; result?: unknown }) {
  await finish(client, input, "succeeded", { result: input.result });
}

/** A failed attempt: retry with the caller's backoff until max_attempts, then `failed`. */
export async function failJob(
  client: Client,
  input: { id: string; leaseToken: string; error: string; retryAt?: Date },
): Promise<{ willRetry: boolean }> {
  const [job] = await client<{ attempts: number; max_attempts: number }[]>`
    select attempts, max_attempts from jobs
    where id = ${input.id} and lease_token = ${input.leaseToken}::uuid and status = 'running'
  `;
  if (!job) throw new JobStaleWriteError();
  const willRetry = job.attempts < job.max_attempts;
  await finish(client, input, willRetry ? "queued" : "failed", { error: input.error, retryAt: willRetry ? (input.retryAt ?? new Date()) : undefined });
  return { willRetry };
}

/** The work may or may not have taken effect. It is never retried blindly; a reconciler decides. */
export async function markJobUnknown(client: Client, input: { id: string; leaseToken: string; error: string }) {
  await finish(client, input, "unknown", { error: input.error });
}

/** Cooperative cancel: queued jobs cancel at once; running jobs see it on the next heartbeat. */
export async function requestJobCancel(client: Client, input: { id: string; workspaceId: string }): Promise<{ status: string }> {
  const [row] = await client<{ status: string }[]>`
    update jobs
    set cancel_requested_at = coalesce(cancel_requested_at, now()),
        status = case when status = 'queued' then 'cancelled' else status end,
        finished_at = case when status = 'queued' then now() else finished_at end,
        updated_at = now(), version = version + 1
    where id = ${input.id} and workspace_id = ${input.workspaceId} and status in ('queued', 'running')
    returning status
  `;
  return { status: row?.status ?? "not_cancellable" };
}

/** A worker that acknowledged cancellation closes its job. */
export async function cancelClaimedJob(client: Client, input: { id: string; leaseToken: string }) {
  await finish(client, input, "cancelled", {});
}

/**
 * Sweeper for dead workers. Expired leases close their attempt as
 * `lease_expired`; the job returns to the queue only when its kind is declared
 * retry-safe (idempotent), otherwise it becomes `unknown` for reconciliation.
 */
export async function recoverExpiredJobs(
  client: Client,
  input: { retrySafeKinds: string[] },
): Promise<{ requeued: string[]; unknown: string[] }> {
  return client.begin(async (tx) => {
    const expired = await tx<{ id: string; kind: string; generation: number; attempts: number; max_attempts: number }[]>`
      select id, kind, generation, attempts, max_attempts from jobs
      where status = 'running' and lease_expires_at <= now()
      for update skip locked
    `;
    const requeued: string[] = [];
    const unknown: string[] = [];
    for (const job of expired) {
      const safe = input.retrySafeKinds.includes(job.kind) && job.attempts < job.max_attempts;
      await tx`
        update job_attempts set ended_at = now(), outcome = 'lease_expired'
        where job_id = ${job.id} and generation = ${job.generation} and ended_at is null
      `;
      await tx`
        update jobs
        set status = ${safe ? "queued" : "unknown"},
            finished_at = case when ${safe} then null else now() end,
            last_error = 'worker lease expired',
            lease_owner = null, lease_token = null, lease_expires_at = null,
            updated_at = now(), version = version + 1
        where id = ${job.id}
      `;
      (safe ? requeued : unknown).push(job.id);
    }
    return { requeued, unknown };
  });
}
