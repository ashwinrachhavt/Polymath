import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { outboxEvents } from "@/domains/audit/schema";
import { generationJobs } from "@/domains/jobs/schema";
import { makeTestDb, ownerAuth, seedWorkspace } from "../helpers/test-workspace";

/*
 * Value: protects=the promises a surface makes when it hands work to the
 * background: one job per intent, the work done (and paid for) once per
 * attempt, a failure the person can see and retry, and a stream that reports
 * it; fails_when=a repeated submit makes a second job or outbox event, two
 * runners both do the work, a failure is retried without being asked or
 * leaves the job running, a retry is not a new attempt, an old attempt
 * settles a retried job, or another member can touch the job; seam=the jobs
 * domain against a real database with scripted runners; no_claim=the Learn
 * generators themselves (flashcards-batching, quiz suites) and the HTTP route.
 */

const handle = makeTestDb();
const holder: { db: ReturnType<typeof drizzle> | undefined } = { db: undefined };
vi.mock("@/lib/db", () => ({
  get db() {
    return holder.db;
  },
}));
vi.mock("@/lib/db-transaction", () => ({
  get withTransaction() {
    return (fn: Parameters<typeof import("@/lib/db-transaction").withTransaction>[0]) =>
      (holder.db!.transaction as typeof import("@/lib/db-transaction").withTransaction)(fn);
  },
}));

import {
  dismissGenerationJob,
  GENERATION_JOB_TOPIC,
  GenerationJobConflictError,
  generationJobRequestedHandler,
  queuedGenerationJobAttempt,
  retryGenerationJob,
  runGenerationJob,
  submitGenerationJob,
} from "@/domains/jobs/commands";
import { listUnfinishedGenerationJobs, tailGenerationJobs } from "@/domains/jobs/queries";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure, STALLED_COPY, UNEXPECTED_FAILURE_COPY } from "@/domains/jobs/state";

beforeAll(() => {
  holder.db = handle.db;
});
afterAll(async () => {
  await handle.client.end();
});

const KIND = "test.thing";
const READY = { href: "/learn/quizzes/made", notice: null };

async function signIn(label: string) {
  const { userId, workspaceId } = await seedWorkspace(holder.db!, `gj-${label}-${Date.now()}`);
  return ownerAuth(userId, workspaceId);
}

function submit(auth: { workspaceId: string; userId: string }, key = crypto.randomUUID(), input: unknown = { n: 1 }) {
  return submitGenerationJob(auth, { kind: KIND, idempotencyKey: key, title: "Quiz: Notes", input });
}

async function stored(jobId: string) {
  const [row] = await holder.db!.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row;
}

async function outboxFor(workspaceId: string) {
  return holder
    .db!.select({ dispatchKey: outboxEvents.dispatchKey, payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.topic, GENERATION_JOB_TOPIC)));
}

describe("generation jobs", () => {
  it("accepts work as a queued job with one outbox event, and returns before any work runs", async () => {
    const auth = await signIn("submit");
    const { job, created } = await submit(auth);

    expect(created).toBe(true);
    expect(job).toMatchObject({ status: "queued", attempt: 1, href: null, error: null });
    expect(await outboxFor(auth.workspaceId)).toEqual([
      { dispatchKey: `${job.id}:1`, payload: { jobId: job.id, attempt: 1 } },
    ]);
    // Still waiting: a page that has watched it wait may start this attempt itself.
    expect(await queuedGenerationJobAttempt(auth, job.id)).toBe(1);
    await runGenerationJob({ jobId: job.id, attempt: 1 }, { [KIND]: async () => READY });
    expect(await queuedGenerationJobAttempt(auth, job.id)).toBeNull();
  });

  it("returns the first job for a repeated submit and enqueues nothing more", async () => {
    const auth = await signIn("dup");
    const key = crypto.randomUUID();
    const [first, second] = await Promise.all([submit(auth, key), submit(auth, key)]);
    const third = await submit(auth, key, { n: 1 });

    expect(new Set([first.job.id, second.job.id, third.job.id]).size).toBe(1);
    expect([first.created, second.created].filter(Boolean)).toHaveLength(1);
    expect(third.created).toBe(false);
    expect(await outboxFor(auth.workspaceId)).toHaveLength(1);
  });

  it("refuses a key reused for a different request", async () => {
    const auth = await signIn("conflict");
    const key = crypto.randomUUID();
    await submit(auth, key, { n: 1 });
    await expect(submit(auth, key, { n: 2 })).rejects.toBeInstanceOf(GenerationJobConflictError);
  });

  it("runs the work once when the worker and an inline run race for the same attempt", async () => {
    const auth = await signIn("race");
    const { job } = await submit(auth);
    const runner = vi.fn<GenerationJobRunner>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return READY;
    });
    const ref = { jobId: job.id, attempt: 1 };
    await Promise.all([runGenerationJob(ref, { [KIND]: runner }), runGenerationJob(ref, { [KIND]: runner })]);

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][2]).toEqual({ generationKey: `${job.id}:1` });
    expect(runner.mock.calls[0][0]).toMatchObject({ userId: auth.userId, workspaceId: auth.workspaceId });
    expect(await stored(job.id)).toMatchObject({ status: "ready", result: READY, error: null });

    await runGenerationJob(ref, { [KIND]: runner });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("shows a failure on the job with its reason, and a retry runs a new attempt to ready", async () => {
    const auth = await signIn("retry");
    const { job } = await submit(auth);
    const failing = vi.fn<GenerationJobRunner>(async () => {
      throw new GenerationJobFailure("The quiz generator did not answer. Try again in a moment.");
    });
    await runGenerationJob({ jobId: job.id, attempt: 1 }, { [KIND]: failing });

    const [listed] = await listUnfinishedGenerationJobs(auth, { kindPrefix: "test." });
    expect(listed).toMatchObject({
      id: job.id,
      status: "failed",
      error: "The quiz generator did not answer. Try again in a moment.",
    });

    const retried = await retryGenerationJob(auth, job.id);
    expect(retried).toMatchObject({ status: "queued", attempt: 2, error: null });
    expect(await retryGenerationJob(auth, job.id)).toBeNull();
    expect((await outboxFor(auth.workspaceId)).map((row) => row.dispatchKey).sort()).toEqual([
      `${job.id}:1`,
      `${job.id}:2`,
    ]);

    const working = vi.fn<GenerationJobRunner>(async () => READY);
    // The first attempt's event is redelivered: it must not run the retried job.
    await runGenerationJob({ jobId: job.id, attempt: 1 }, { [KIND]: working });
    expect(working).not.toHaveBeenCalled();
    await runGenerationJob({ jobId: job.id, attempt: 2 }, { [KIND]: working });
    expect(working.mock.calls[0][2]).toEqual({ generationKey: `${job.id}:2` });
    expect(await stored(job.id)).toMatchObject({ status: "ready", attempt: 2, result: READY });
    expect(await listUnfinishedGenerationJobs(auth, { kindPrefix: "test." })).toEqual([]);
  });

  it("fails with authored copy, never the thrown message, when the work breaks unexpectedly", async () => {
    const auth = await signIn("unexpected");
    const { job } = await submit(auth);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await runGenerationJob(
      { jobId: job.id, attempt: 1 },
      {
        [KIND]: async () => {
          throw new Error('insert into "quizzes" failed: secret');
        },
      },
    );
    quiet.mockRestore();
    expect(await stored(job.id)).toMatchObject({ status: "failed", error: UNEXPECTED_FAILURE_COPY });
  });

  it("fails a job whose kind has no runner instead of leaving it running", async () => {
    const auth = await signIn("norunner");
    const { job } = await submit(auth);
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await generationJobRequestedHandler({
      id: crypto.randomUUID(),
      workspaceId: auth.workspaceId,
      topic: GENERATION_JOB_TOPIC,
      payload: { jobId: job.id, attempt: 1 },
      attempts: 0,
      leaseToken: crypto.randomUUID(),
    });
    quiet.mockRestore();
    expect(await stored(job.id)).toMatchObject({ status: "failed", error: UNEXPECTED_FAILURE_COPY });
  });

  it("reads a run whose heartbeat stopped as failed, lets it be retried, and ignores the dead run's result", async () => {
    const auth = await signIn("stalled");
    const { job } = await submit(auth);
    let finishDeadRun: (value: typeof READY) => void = () => {};
    const deadRun = runGenerationJob(
      { jobId: job.id, attempt: 1 },
      { [KIND]: () => new Promise((resolve) => (finishDeadRun = resolve)) },
    );
    await vi.waitFor(async () => expect((await stored(job.id)).status).toBe("running"));
    await holder
      .db!.update(generationJobs)
      .set({ heartbeatAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(generationJobs.id, job.id));

    const [listed] = await listUnfinishedGenerationJobs(auth, { kindPrefix: "test." });
    expect(listed).toMatchObject({ status: "failed", error: STALLED_COPY });

    expect(await retryGenerationJob(auth, job.id)).toMatchObject({ status: "queued", attempt: 2 });
    finishDeadRun(READY);
    await deadRun;
    expect(await stored(job.id)).toMatchObject({ status: "queued", attempt: 2, result: null });
  });

  it("keeps a job to its maker: another member can neither retry, dismiss nor see it", async () => {
    const auth = await signIn("owner");
    const stranger = await signIn("stranger");
    const { job } = await submit(auth);
    await runGenerationJob(
      { jobId: job.id, attempt: 1 },
      {
        [KIND]: async () => {
          throw new GenerationJobFailure("No.");
        },
      },
    );

    expect(await queuedGenerationJobAttempt(stranger, job.id)).toBeNull();
    expect(await retryGenerationJob(stranger, job.id)).toBeNull();
    expect(await dismissGenerationJob(stranger, job.id)).toBe(false);
    expect(await listUnfinishedGenerationJobs(stranger, { kindPrefix: "test." })).toEqual([]);
    expect((await tailGenerationJobs(stranger, new Date(0))).jobs).toEqual([]);

    expect(await dismissGenerationJob(auth, job.id)).toBe(true);
    expect(await stored(job.id)).toBeUndefined();
  });

  it("lists one thing's jobs to the surface that asks for them, and all of a kind to the one that does not", async () => {
    const auth = await signIn("subject");
    const forNotebook = await submitGenerationJob(auth, {
      kind: KIND,
      subject: "notebook:n1",
      idempotencyKey: crypto.randomUUID(),
      title: "Quiz: Chapter one",
      input: {},
    });
    const forNothing = await submit(auth);

    const notebook = await listUnfinishedGenerationJobs(auth, { kindPrefix: "test.", subject: "notebook:n1" });
    expect(notebook.map((job) => job.id)).toEqual([forNotebook.job.id]);
    expect(notebook[0].subject).toBe("notebook:n1");
    expect(await listUnfinishedGenerationJobs(auth, { kindPrefix: "test.", subject: "notebook:other" })).toEqual([]);
    const every = await listUnfinishedGenerationJobs(auth, { kindPrefix: "test." });
    expect(every.map((job) => job.id).sort()).toEqual([forNotebook.job.id, forNothing.job.id].sort());
    expect(await listUnfinishedGenerationJobs(auth, { kindPrefix: "other." })).toEqual([]);
  });

  it("tails jobs still being made and jobs that changed since the cursor, and nothing older", async () => {
    const auth = await signIn("tail");
    const waiting = await submit(auth);
    const done = await submit(auth);
    await runGenerationJob({ jobId: done.job.id, attempt: 1 }, { [KIND]: async () => READY });

    const first = await tailGenerationJobs(auth, null);
    expect(first.jobs.map((job) => [job.id, job.status]).sort()).toEqual(
      [
        [waiting.job.id, "queued"],
        [done.job.id, "ready"],
      ].sort(),
    );

    await holder
      .db!.update(generationJobs)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(generationJobs.id, done.job.id));
    const later = await tailGenerationJobs(auth, first.now);
    expect(later.jobs.map((job) => job.id)).toEqual([waiting.job.id]);
    expect(later.now.getTime()).toBeGreaterThanOrEqual(first.now.getTime());
  });
});
