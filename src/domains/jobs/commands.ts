import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { enqueueOutbox, type OutboxHandler } from "@/domains/audit/outbox";
import type { AuthContext } from "@/domains/identity/resolve";
import { memberships } from "@/domains/identity/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { generationJobRunners, type GenerationJobRunner } from "./runners";
import { generationJobs, type GenerationJobResult } from "./schema";
import {
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
 */
export async function submitGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  input: { kind: string; subject?: string; idempotencyKey: string; title: string; input: unknown },
): Promise<{ job: GenerationJobView; created: boolean }> {
  return withTransaction(async (tx) => {
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
  });
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
  const heartbeat = setInterval(() => {
    db.update(generationJobs)
      .set({ heartbeatAt: sql`now()` })
      .where(mine)
      .catch(() => {
        // A missed beat is tolerated; six in a row read as stalled.
      });
  }, HEARTBEAT_EVERY_MS);

  let outcome: { status: "ready"; result: GenerationJobResult } | { status: "failed"; error: string };
  try {
    const auth = await makerAuth(job);
    const runner = runners[job.kind];
    if (!auth || !runner) throw new Error(auth ? `no runner for ${job.kind}` : "the job's maker left the workspace");
    outcome = {
      status: "ready",
      result: await runner(auth, job.input, { generationKey: `${ref.jobId}:${ref.attempt}` }),
    };
  } catch (cause) {
    if (!(cause instanceof GenerationJobFailure)) console.error("[generation-job] run failed", ref.jobId, cause);
    outcome = {
      status: "failed",
      error: cause instanceof GenerationJobFailure ? cause.message.slice(0, 500) : UNEXPECTED_FAILURE_COPY,
    };
  } finally {
    clearInterval(heartbeat);
  }
  await db
    .update(generationJobs)
    .set(
      outcome.status === "ready"
        ? { status: "ready", result: outcome.result, updatedAt: sql`now()` }
        : { status: "failed", error: outcome.error, updatedAt: sql`now()` },
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
 * Puts a failed (or stalled) job back in the queue as a new attempt. Returns
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

/** Removes a failed (or stalled) job its maker no longer wants to see. True when a row went. */
export async function dismissGenerationJob(
  auth: Pick<AuthContext, "workspaceId" | "userId">,
  jobId: string,
): Promise<boolean> {
  const removed = await db
    .delete(generationJobs)
    .where(and(ownedBy(auth, jobId), or(eq(generationJobs.status, "failed"), stalledSql())))
    .returning({ id: generationJobs.id });
  return removed.length > 0;
}

/** The outbox consumer. A malformed event can never succeed, so it completes instead of retrying. */
export const generationJobRequestedHandler: OutboxHandler = async (event) => {
  const payload = event.payload as { jobId?: unknown; attempt?: unknown } | null;
  if (typeof payload?.jobId !== "string" || typeof payload.attempt !== "number") return;
  await runGenerationJob({ jobId: payload.jobId, attempt: payload.attempt });
};
