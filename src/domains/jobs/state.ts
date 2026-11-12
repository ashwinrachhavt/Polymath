/*
 * The generation job state machine, with no database in it.
 *
 *   queued --claim--> running --settle--> ready
 *                        |
 *                        +----settle----> failed --retry--> queued
 *
 * A running job proves it is alive with a heartbeat. One whose heartbeat has
 * been silent for STALLED_AFTER_MS reads as failed (its runner died, or its
 * serverless function was cut off), and a retry is legal from there too:
 * nobody is left holding a spinner for work that will never finish.
 */

export type GenerationJobStatus = "queued" | "running" | "ready" | "failed";

const TRANSITIONS: Record<GenerationJobStatus, readonly GenerationJobStatus[]> = {
  queued: ["running"],
  running: ["ready", "failed"],
  ready: [],
  failed: ["queued"],
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

export const STALLED_COPY = "This stopped before it finished. Try again.";
export const UNEXPECTED_FAILURE_COPY = "Something went wrong while making this. Try again.";

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
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export function isSettled(status: GenerationJobStatus): boolean {
  return status === "ready" || status === "failed";
}

/** Changes exactly when a surface has something new to show, so a stream can skip what it already sent. */
export function jobSignature(view: Pick<GenerationJobView, "status" | "attempt">): string {
  return `${view.attempt}:${view.status}`;
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
