import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { enqueueOutbox, type OutboxHandler } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { memberships } from "@/domains/identity/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { generationJobRunners, type GenerationJobRun, type GenerationJobRunner } from "./runners";
import { generationJobs, type GenerationJobResult } from "./schema";
import {
  GenerationJobCancelled,
  GenerationJobFailure,
  HEARTBEAT_EVERY_MS,
  STALLED_AFTER_MS,
  statusesThatMayBecome,
  toJobView,
  UNEXPECTED_FAILURE_COPY,
  type GenerationJobView,
} from "./state";

/*
 * The write side of generation jobs. Callers may rely on:
 *
 * - submitGenerationJob returns at once. The job and the outbox event that
 *   runs it commit together, so accepted work is never lost; a repeated
 *   idempotency key returns the first job and enqueues nothing.
 * - runGenerationJob does the work at most once per attempt. The claim is a
 *   conditional update, so the outbox worker and an inline kick may both call
 *   it for the same job and only one runs the runner (and pays for it).
 * - A failure never throws out of runGenerationJob: it lands on the row as
 *   authored copy, and the person retries from there. The outbox therefore
 *   never re-runs a failed generation on its own.
 * - cancelGenerationJob settles a queued or running job as cancelled at once.
 *   A running runner sees run.signal abort at its next progress report or
 *   heartbeat; nothing it does after that can settle the job.
 * - Every command is scoped to the workspace and the job's maker.
 */

export const GENERATION_JOB_TOPIC = "generation.job_requested";

export class GenerationJobConflictError extends Error {
  constructor() {
    super("This request key already belongs to a different request.");
    this.name = "GenerationJobConflictError";
  }
}

/** The columns toJobView reads. */
export const jobViewColumns = {
  id: generationJobs.id,
  kind: generationJobs.kind,
  subject: generationJobs.subject,
  status: generationJobs.status,
  title: generationJobs.title,
  attempt: generationJobs.attempt,
  result: generationJobs.result,
  error: generationJobs.error,
  progress: generationJobs.progress,
  costMicroUsd: generationJobs.costMicroUsd,
  createdAt: generationJobs.createdAt,
  updatedAt: generationJobs.updatedAt,
  stalled: stalledSql().mapWith(Boolean),
};

/** True for a running job whose heartbeat has been silent too long, by the database's clock. */
function stalledSql(): SQL<boolean> {
  return sql<boolean>`(${generationJobs.status} = 'running' and coalesce(${generationJobs.heartbeatAt}, ${generationJobs.updatedAt}) < now() - (${STALLED_AFTER_MS}::double precision * interval '1 millisecond'))`;
}

function ownedBy(auth: Pick<AuthContext, "workspaceId" | "userId">, jobId: string) {
  return and(
    eq(generationJobs.id, jobId),
    eq(generationJobs.workspaceId, auth.workspaceId),
    eq(generationJobs.createdBy, auth.userId),
  );
}

/** Key order must not make two equal inputs differ: jsonb does not keep it. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

/**
 * Accepts work for later. `created` is false when the key was seen before:
 * the first job is returned whatever state it has reached. The same key with
 * a different kind, maker or input throws GenerationJobConflictError.
 *
 * Pass `tx` to accept the job in the caller's transaction, so the job exists
 * exactly when the thing it works on does. Start it (kickGenerationJob) only
 * after that transaction commits.
 */
export async function submitGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { kind: string; subject?: string; idempotencyKey: string; title: string; input: unknown },
  outer?: TxDrizzle,
): Promise<{ job: GenerationJobView; created: boolean }> {
  const accept = async (tx: TxDrizzle) => {
    const [created] = await tx
      .insert(generationJobs)
      .values({
        workspaceId: auth.workspaceId,
        kind: input.kind,
        subject: input.subject,
        idempotencyKey: input.idempotencyKey,
        title: input.title.slice(0, 200),
        input: input.input,
        createdBy: auth.userId,
      })
      .onConflictDoNothing({ target: [generationJobs.workspaceId, generationJobs.idempotencyKey] })
      .returning(jobViewColumns);
    if (created) {
      await enqueueOutbox(tx, auth, {
        topic: GENERATION_JOB_TOPIC,
        payload: { jobId: created.id, attempt: created.attempt },
        dispatchKey: `${created.id}:${created.attempt}`,
      });
      return { job: toJobView(created), created: true };
    }
    const [existing] = await tx
      .select({ ...jobViewColumns, createdBy: generationJobs.createdBy, input: generationJobs.input })
      .from(generationJobs)
      .where(
        and(eq(generationJobs.workspaceId, auth.workspaceId), eq(generationJobs.idempotencyKey, input.idempotencyKey)),
      )
      .limit(1);
    if (
      !existing ||
      existing.createdBy !== auth.userId ||
      existing.kind !== input.kind ||
      canonical(existing.input) !== canonical(input.input)
    ) {
      throw new GenerationJobConflictError();
    }
    return { job: toJobView(existing), created: false };
  };
  return outer ? accept(outer) : withTransaction(accept);
}

/**
 * The same as submitGenerationJob, except that asking again for work whose
 * job failed or was stopped tries that job again (a new attempt) instead of
 * returning it settled. For work that has one job per thing, such as a
 * capture's crawl or a video's absorption, where asking again means "again".
 * `started` names the attempt to kick, or is null when nothing new was queued.
 */
export async function submitOrRetryGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: Parameters<typeof submitGenerationJob>[1],
): Promise<{ job: GenerationJobView; started: { jobId: string; attempt: number } | null }> {
  const { job, created } = await submitGenerationJob(auth, input);
  if (created) return { job, started: { jobId: job.id, attempt: job.attempt } };
  if (job.status !== "failed" && job.status !== "cancelled") return { job, started: null };
  const retried = await retryGenerationJob(auth, job.id);
  return retried ? { job: retried, started: { jobId: retried.id, attempt: retried.attempt } } : { job, started: null };
}

/**
 * Runs one attempt of a job, if it is still waiting for it. Resolves once the
 * job is settled (or was not this caller's to run); rejects only when the
 * database itself fails.
 */
export async function runGenerationJob(
  ref: { jobId: string; attempt: number },
  runners: Record<string, GenerationJobRunner> = generationJobRunners(),
): Promise<void> {
  const [job] = await db
    .update(generationJobs)
    .set({ status: "running", heartbeatAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(generationJobs.id, ref.jobId),
        eq(generationJobs.attempt, ref.attempt),
        inArray(generationJobs.status, statusesThatMayBecome("running")),
      ),
    )
    .returning({
      workspaceId: generationJobs.workspaceId,
      createdBy: generationJobs.createdBy,
      kind: generationJobs.kind,
      input: generationJobs.input,
    });
  if (!job) return;

  // Fenced by the attempt: a run that outlived its retry settles nothing.
  const mine = and(
    eq(generationJobs.id, ref.jobId),
    eq(generationJobs.attempt, ref.attempt),
    eq(generationJobs.status, "running"),
  );
  const cancelled = new AbortController();
  /** A write fenced to this live attempt that touched no row means the job was cancelled (or retried) under us. */
  const stillMine = (rows: unknown[]) => {
    if (rows.length === 0 && !cancelled.signal.aborted) cancelled.abort(new GenerationJobCancelled());
    return rows.length > 0;
  };
  const heartbeat = setInterval(() => {
    db.update(generationJobs)
      .set({ heartbeatAt: sql`now()` })
      .where(mine)
      .returning({ id: generationJobs.id })
      .then(stillMine)
      .catch(() => {
        // A missed beat is tolerated; six in a row read as stalled.
      });
  }, HEARTBEAT_EVERY_MS);

  const run: GenerationJobRun = {
    generationKey: `${ref.jobId}:${ref.attempt}`,
    signal: cancelled.signal,
    async progress(step, counts) {
      if (cancelled.signal.aborted) throw new GenerationJobCancelled();
      const rows = await db
        .update(generationJobs)
        .set({
          progress: { step: step.slice(0, 120), done: counts?.done ?? null, total: counts?.total ?? null },
          progressAt: sql`now()`,
          heartbeatAt: sql`now()`,
        })
        .where(mine)
        .returning({ id: generationJobs.id });
      if (!stillMine(rows)) throw new GenerationJobCancelled();
    },
    async spend(microUsd) {
      const amount = Math.max(0, Math.round(microUsd));
      if (amount === 0) return;
      // Fenced by the attempt, not the status: money spent before a cancel was still spent.
      await db
        .update(generationJobs)
        .set({ costMicroUsd: sql`${generationJobs.costMicroUsd} + ${amount}` })
        .where(and(eq(generationJobs.id, ref.jobId), eq(generationJobs.attempt, ref.attempt)));
    },
  };

  let outcome: { status: "ready"; result: GenerationJobResult } | { status: "failed"; error: string } | null;
  try {
    const auth = await makerAuth(job);
    const runner = runners[job.kind];
    if (!auth || !runner) throw new Error(auth ? `no runner for ${job.kind}` : "the job's maker left the workspace");
    outcome = { status: "ready", result: await runner(auth, job.input, run) };
  } catch (cause) {
    if (cause instanceof GenerationJobCancelled || cancelled.signal.aborted) {
      outcome = null;
    } else {
      if (!(cause instanceof GenerationJobFailure)) console.error("[generation-job] run failed", ref.jobId, cause);
      outcome = {
        status: "failed",
        error: cause instanceof GenerationJobFailure ? cause.message.slice(0, 500) : UNEXPECTED_FAILURE_COPY,
      };
    }
  } finally {
    clearInterval(heartbeat);
  }
  // A cancelled run has nothing to settle: cancelGenerationJob already did.
  if (!outcome) return;
  await db
    .update(generationJobs)
    .set(
      outcome.status === "ready"
        ? { status: "ready", result: outcome.result, progress: null, updatedAt: sql`now()` }
        : { status: "failed", error: outcome.error, progress: null, updatedAt: sql`now()` },
    )
    .where(mine);
}

/** The job's maker as they stand in the workspace now. Null once they are no longer an active member. */
async function makerAuth(job: { workspaceId: string; createdBy: string }): Promise<AuthContext | null> {
  const [row] = await db
    .select({ role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, job.workspaceId),
        eq(memberships.userId, job.createdBy),
        eq(memberships.status, "active"),
      ),
    )
    .limit(1);
  return row ? { userId: job.createdBy, workspaceId: job.workspaceId, role: row.role } : null;
}

/**
 * The attempt a job is still waiting to start, or null when it is not the
 * caller's or is no longer queued. Lets a surface that has watched a job wait
 * too long start it again (kickGenerationJob) without waiting for the worker.
 */
export async function queuedGenerationJobAttempt(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  jobId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ attempt: generationJobs.attempt })
    .from(generationJobs)
    .where(and(ownedBy(auth, jobId), eq(generationJobs.status, "queued")))
    .limit(1);
  return row?.attempt ?? null;
}

/**
 * Stops a queued or running job. The row settles as cancelled now; a running
 * runner stops at its next progress report or heartbeat (run.signal). Null
 * when the job is not the caller's or has already settled.
 */
export async function cancelGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  jobId: string,
): Promise<GenerationJobView | null> {
  const [job] = await db
    .update(generationJobs)
    .set({ status: "cancelled", progress: null, heartbeatAt: null, updatedAt: sql`now()` })
    .where(and(ownedBy(auth, jobId), inArray(generationJobs.status, statusesThatMayBecome("cancelled"))))
    .returning(jobViewColumns);
  return job ? toJobView(job) : null;
}

/**
 * Puts a failed, cancelled (or stalled) job back in the queue as a new attempt. Returns
 * null when the job is not the caller's or is not in a state a retry applies
 * to, which includes a second click on Retry: one retry, one attempt.
 */
export async function retryGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  jobId: string,
): Promise<GenerationJobView | null> {
  return withTransaction(async (tx) => {
    const [job] = await tx
      .update(generationJobs)
      .set({
        status: "queued",
        attempt: sql`${generationJobs.attempt} + 1`,
        error: null,
        heartbeatAt: null,
        progress: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(ownedBy(auth, jobId), or(inArray(generationJobs.status, statusesThatMayBecome("queued")), stalledSql())),
      )
      .returning(jobViewColumns);
    if (!job) return null;
    await enqueueOutbox(tx, auth, {
      topic: GENERATION_JOB_TOPIC,
      payload: { jobId: job.id, attempt: job.attempt },
      dispatchKey: `${job.id}:${job.attempt}`,
    });
    return toJobView(job);
  });
}

/** Removes a failed, cancelled (or stalled) job its maker no longer wants to see. True when a row went. */
export async function dismissGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  jobId: string,
): Promise<boolean> {
  const removed = await db
    .delete(generationJobs)
    .where(and(ownedBy(auth, jobId), or(inArray(generationJobs.status, ["failed", "cancelled"]), stalledSql())))
    .returning({ id: generationJobs.id });
  return removed.length > 0;
}

/** The outbox consumer. A malformed event can never succeed, so it completes instead of retrying. */
export const generationJobRequestedHandler: OutboxHandler = async (event) => {
  const payload = event.payload as { jobId?: unknown; attempt?: unknown } | null;
  if (typeof payload?.jobId !== "string" || typeof payload.attempt !== "number") return;
  await runGenerationJob({ jobId: payload.jobId, attempt: payload.attempt });
};
