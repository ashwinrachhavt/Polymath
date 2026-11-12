/*
 * The generation job state machine, with no database in it.
 *
 *   queued --claim--> running --settle--> ready
 *     |                  |
 *     |                  +----settle----> failed ----retry--> queued
 *     |                  |
 *     +-----cancel-------+----cancel----> cancelled --retry--> queued
 *
 * Cancelling a running job settles it at once; its runner learns of it at its
 * next progress report or heartbeat (run.signal aborts) and stops, and the
 * attempt fence keeps anything it finishes afterwards from landing.
 *
 * A running job proves it is alive with a heartbeat. One whose heartbeat has
 * been silent for STALLED_AFTER_MS reads as failed (its runner died, or its
 * serverless function was cut off), and a retry is legal from there too:
 * nobody is left holding a spinner for work that will never finish.
 */

export type GenerationJobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

const TRANSITIONS: Record<GenerationJobStatus, readonly GenerationJobStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["ready", "failed", "cancelled"],
  ready: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

/** Every status a job may leave to become `to`. Commands guard their updates with this, so the table above is the one rule. */
export function statusesThatMayBecome(to: GenerationJobStatus): GenerationJobStatus[] {
  return (Object.keys(TRANSITIONS) as GenerationJobStatus[]).filter((from) => TRANSITIONS[from].includes(to));
}

/** The SSE event name the jobs stream sends and the browser listens for. */
export const GENERATION_JOB_EVENT = "job";

export const HEARTBEAT_EVERY_MS = 15_000;
/** Six missed heartbeats. Long enough for a slow database, short enough to be honest. */
export const STALLED_AFTER_MS = 90_000;

/** How long a job may sit in the queue before a watching page starts it itself and says it is slow. */
export const SLOW_TO_START_AFTER_MS = 20_000;

export const STALLED_COPY = "This stopped before it finished. Try again.";
export const UNEXPECTED_FAILURE_COPY = "Something went wrong while making this. Try again.";

/** What the run is doing now. Counts are null when the step has none. */
export type GenerationJobProgress = { step: string; done: number | null; total: number | null };

/** What every surface shows for a job. `href` is set once it is ready, `error` once it has failed. */
export type GenerationJobView = {
  id: string;
  kind: string;
  /** What the work is for ("notebook:<id>", "document:<id>"), or null. */
  subject: string | null;
  status: GenerationJobStatus;
  title: string;
  attempt: number;
  href: string | null;
  notice: string | null;
  error: string | null;
  /** The latest step while it runs; null once it is settled or before it starts. */
  progress: GenerationJobProgress | null;
  /** Paid provider spend so far, in US dollars. */
  costUsd: number;
  /** ISO time the job was accepted. Lists order by it, newest first. */
  createdAt: string;
  /** ISO time of the last status change, by the database's clock. */
  updatedAt: string;
};

export type GenerationJobFacts = {
  id: string;
  kind: string;
  subject: string | null;
  status: GenerationJobStatus;
  title: string;
  attempt: number;
  result: { href: string; notice: string | null } | null;
  error: string | null;
  progress: GenerationJobProgress | null;
  costMicroUsd: number;
  createdAt: Date;
  updatedAt: Date;
  /** Running with a heartbeat older than STALLED_AFTER_MS, judged by the database's clock. */
  stalled: boolean;
};

/** The stored row as surfaces see it: a stalled run is a failure with a retry, never a spinner. */
export function toJobView(job: GenerationJobFacts): GenerationJobView {
  const stalled = job.status === "running" && job.stalled;
  return {
    id: job.id,
    kind: job.kind,
    subject: job.subject,
    status: stalled ? "failed" : job.status,
    title: job.title,
    attempt: job.attempt,
    href: job.status === "ready" ? (job.result?.href ?? null) : null,
    notice: job.status === "ready" ? (job.result?.notice ?? null) : null,
    error: stalled ? STALLED_COPY : job.status === "failed" ? job.error : null,
    progress: job.status === "running" && !stalled ? job.progress : null,
    costUsd: job.costMicroUsd / 1_000_000,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function isSettled(status: GenerationJobStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

/** Changes exactly when a surface has something new to show, so a stream can skip what it already sent. */
export function jobSignature(view: Pick<GenerationJobView, "status" | "attempt" | "progress">): string {
  const step = view.progress ? `:${view.progress.step}:${view.progress.done ?? ""}/${view.progress.total ?? ""}` : "";
  return `${view.attempt}:${view.status}${step}`;
}

/** The step line a surface shows: "Crawling 12/25". */
export function progressLabel(progress: GenerationJobProgress): string {
  if (progress.done === null) return progress.step;
  return progress.total === null
    ? `${progress.step} ${progress.done}`
    : `${progress.step} ${progress.done}/${progress.total}`;
}

/** 0..1 when the step counts toward a known total, else null (an indeterminate bar). */
export function progressFraction(progress: GenerationJobProgress | null): number | null {
  if (!progress || progress.done === null || !progress.total) return null;
  return Math.min(1, Math.max(0, progress.done / progress.total));
}

/**
 * A runner throws this to fail its job with copy the person can read. Any
 * other error fails the job with UNEXPECTED_FAILURE_COPY.
 */
export class GenerationJobFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenerationJobFailure";
  }
}

/** Thrown into a runner (from run.progress) once its job was cancelled; the run stops and settles nothing. */
export class GenerationJobCancelled extends Error {
  constructor() {
    super("The job was cancelled.");
    this.name = "GenerationJobCancelled";
  }
}
