"use client";

import { useEffect, useSyncExternalStore } from "react";
import { z } from "zod";
import { useWorkspace } from "@/components/workspace/workspace-provider";
import type { WorkState } from "@/components/work-status";
import { GENERATION_JOB_EVENT, isSettled, jobSignature, type GenerationJobView } from "@/domains/jobs/state";

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
  status: z.enum(["queued", "running", "ready", "failed"]),
  title: z.string(),
  attempt: z.number(),
  href: z.string().nullable(),
  notice: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

type Jobs = ReadonlyMap<string, GenerationJobView>;

const EMPTY: Jobs = new Map();
let jobs: Jobs = EMPTY;
const listeners = new Set<() => void>();

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
  if (job.status === "ready") return { phase: "done", label: job.notice ?? "Ready." };
  if (job.status === "running") return { phase: "working", label: "Being made. You can leave this page." };
  return { phase: "queued", label: "Waiting to start. You can leave this page." };
}

/**
 * Holds the tab's one connection to the jobs stream and announces a job that
 * settles, wherever the person is by then. EventSource reconnects by itself
 * and resumes from the last event it saw.
 */
export function GenerationJobsMount() {
  const { notify } = useWorkspace();
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
      if (!isSettled(job.status)) return;
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
      publish(EMPTY);
    };
  }, [notify]);
  return null;
}
