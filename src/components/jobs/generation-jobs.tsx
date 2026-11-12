"use client";

import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { WorkState } from "@/components/work-status";
import { startWaitingGenerationJobAction } from "@/domains/jobs/actions";
import {
  GENERATION_JOB_EVENT,
  isSettled,
  jobSignature,
  progressLabel,
  SLOW_TO_START_AFTER_MS,
  type GenerationJobView,
} from "@/domains/jobs/state";

/*
 * The browser half of the generation jobs push channel. One EventSource per
 * tab (GenerationJobsMount, in the shell) feeds one store; any surface reads
 * it with useGenerationJobs and never asks the server how a job is doing.
 *
 * The store is a view of the server's rows, not a second truth: a page load
 * reads the rows themselves, and the store only adds what changed since.
 */

const STREAM_URL = "/api/v1/generation-jobs/stream";

const viewSchema = z.object({
  id: z.string(),
  kind: z.string(),
  subject: z.string().nullable(),
  status: z.enum(["queued", "running", "ready", "failed", "cancelled"]),
  title: z.string(),
  attempt: z.number(),
  href: z.string().nullable(),
  notice: z.string().nullable(),
  error: z.string().nullable(),
  progress: z.object({ step: z.string(), done: z.number().nullable(), total: z.number().nullable() }).nullable(),
  costUsd: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type Jobs = ReadonlyMap<string, GenerationJobView>;

const EMPTY: Jobs = new Map();
let jobs: Jobs = EMPTY;
const listeners = new Set<() => void>();

/** Queued attempts this tab has already watched wait too long, keyed by signature and id. */
const slowToStart = new Set<string>();

function publish(next: Jobs) {
  jobs = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Records a job's state, e.g. the one a submit or retry just returned, so its row shows before the stream says so. */
export function trackGenerationJob(job: GenerationJobView): void {
  const known = jobs.get(job.id);
  if (known && jobSignature(known) === jobSignature(job)) return;
  publish(new Map(jobs).set(job.id, job));
}

/** Drops a job the person dismissed. */
export function forgetGenerationJob(jobId: string): void {
  if (!jobs.has(jobId)) return;
  const next = new Map(jobs);
  next.delete(jobId);
  publish(next);
}

/** Every job this tab has heard about, keyed by id. */
export function useGenerationJobs(): Jobs {
  return useSyncExternalStore(
    subscribe,
    () => jobs,
    () => EMPTY,
  );
}

/** A job's state in the shared status-line vocabulary (WorkStatus). */
export function jobWorkState(job: GenerationJobView): WorkState {
  if (job.status === "failed") return { phase: "failed", label: job.error ?? "This could not be made." };
  if (job.status === "cancelled") return { phase: "failed", label: "Stopped." };
  if (job.status === "ready") return { phase: "done", label: job.notice ?? "Ready." };
  if (job.status === "running") {
    return { phase: "working", label: job.progress ? `${progressLabel(job.progress)}…` : "Being made. You can leave this page." };
  }
  if (slowToStart.has(jobSignature(job) + job.id)) {
    return { phase: "queued", label: "Taking longer than usual to start. Still trying." };
  }
  return { phase: "queued", label: "Waiting to start. You can leave this page." };
}

/**
 * Holds the tab's one connection to the jobs stream and announces a job that
 * settles, wherever the person is by then. EventSource reconnects by itself
 * and resumes from the last event it saw.
 */
export function GenerationJobsMount() {
  const { notify } = useWorkspace();
  const known = useGenerationJobs();

  // A job still queued after SLOW_TO_START_AFTER_MS was not started by its submit: start it once, and say it is slow.
  const waiting = [...known.values()].filter((job) => job.status === "queued");
  const waitingKey = waiting.map((job) => jobSignature(job) + job.id).join(",");
  useEffect(() => {
    const timers = waiting
      .filter((job) => !slowToStart.has(jobSignature(job) + job.id))
      .map((job) => {
        const overdueIn = Math.max(0, new Date(job.updatedAt).getTime() + SLOW_TO_START_AFTER_MS - Date.now());
        return setTimeout(() => {
          if (jobs.get(job.id)?.status !== "queued") return;
          slowToStart.add(jobSignature(job) + job.id);
          publish(new Map(jobs));
          void startWaitingGenerationJobAction(job.id).catch(() => {});
        }, overdueIn);
      });
    return () => timers.forEach(clearTimeout);
    // The key names every waiting attempt; the list itself is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);

  useEffect(() => {
    const source = new EventSource(STREAM_URL);
    const onJob = (event: MessageEvent<string>) => {
      let parsed;
      try {
        parsed = viewSchema.safeParse(JSON.parse(event.data));
      } catch {
        return;
      }
      if (!parsed.success) return;
      const job = parsed.data;
      const known = jobs.get(job.id);
      if (known && jobSignature(known) === jobSignature(job)) return;
      trackGenerationJob(job);
      // A stop is the person's own click; it needs no announcement.
      if (!isSettled(job.status) || job.status === "cancelled") return;
      notify(
        job.status === "ready"
          ? `${job.title} is ready.${job.notice ? ` ${job.notice}` : ""}`
          : `${job.title} could not be made. ${job.error ?? ""}`.trim(),
      );
    };
    source.addEventListener(GENERATION_JOB_EVENT, onJob);
    return () => {
      source.removeEventListener(GENERATION_JOB_EVENT, onJob);
      source.close();
      slowToStart.clear();
      publish(EMPTY);
    };
  }, [notify]);
  return null;
}
