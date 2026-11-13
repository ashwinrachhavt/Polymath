"use client";

import { useEffect, useState } from "react";
import { cn } from "cn";
import { useGenerationJobs } from "@/components/jobs/generation-jobs";
import { JobMark } from "@/components/jobs/job-mark";
import { progressFraction, progressLabel, type GenerationJobView } from "@/domains/jobs/state";

/*
 * A job's progress under the thing it works on: one thin bar in the accent
 * colour and the live step ("Crawling 12/25…"), or a plain "Queued" before it
 * starts. When the job finishes while the row is on screen, the mark closes
 * into a check with what it made for a moment, then the component clears and
 * the row is just the row. A job that was already settled when the row
 * rendered shows nothing; a failure stays, with its reason.
 *
 * Mount SubjectJobProgress under a row's title to follow that row's job.
 */

const SETTLED_VISIBLE_MS = 2_400;

/** The newest job a subject ("capture:<id>", "document:<id>") has in this tab's store, or null. */
function useJobForSubject(subject: string): GenerationJobView | null {
  const jobs = useGenerationJobs();
  let newest: GenerationJobView | null = null;
  for (const job of jobs.values()) {
    if (job.subject !== subject || job.status === "cancelled") continue;
    if (!newest || job.createdAt > newest.createdAt) newest = job;
  }
  return newest;
}

export function JobProgress({ job, className }: { job: GenerationJobView | null; className?: string }) {
  // Whether this mount saw the job unfinished: only then is a finish worth showing.
  const [sawUnfinished, setSawUnfinished] = useState(false);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const unfinished = job?.status === "queued" || job?.status === "running";
  if (unfinished && !sawUnfinished) setSawUnfinished(true);

  const finishedNow = Boolean(job && job.status === "ready" && sawUnfinished && dismissedId !== job.id);
  useEffect(() => {
    if (!finishedNow || !job) return;
    const timer = setTimeout(() => setDismissedId(job.id), SETTLED_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [finishedNow, job]);

  if (!job) return null;

  if (job.status === "queued") {
    return (
      <p data-job-progress="queued" className={cn("text-xs text-muted-foreground", className)}>
        Queued
      </p>
    );
  }

  if (job.status === "running") {
    const fraction = progressFraction(job.progress);
    return (
      <div data-job-progress="running" className={cn("min-w-0", className)}>
        <div
          role="progressbar"
          aria-label={job.title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
          className="h-0.5 w-full overflow-hidden rounded-full bg-primary/15"
        >
          <div
            className={cn(
              "h-full rounded-full bg-primary transition-[width] duration-300 ease-out",
              fraction === null && "job-progress-indeterminate w-1/3",
            )}
            style={fraction === null ? undefined : { width: `${Math.max(4, fraction * 100)}%` }}
          />
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground tabular-nums">
          {job.progress ? `${progressLabel(job.progress)}…` : "Starting…"}
        </p>
      </div>
    );
  }

  if (job.status === "ready" && finishedNow) {
    return (
      <p
        data-job-progress="ready"
        className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", className)}
        role="status"
      >
        <JobMark status="ready" className="size-3.5 text-primary" />
        <span className="truncate">{job.notice ?? "Done."}</span>
      </p>
    );
  }

  if (job.status === "failed") {
    return (
      <p
        data-job-progress="failed"
        className={cn("flex items-center gap-1.5 text-xs text-destructive", className)}
        role="alert"
      >
        <JobMark status="failed" className="size-3.5" />
        <span className="truncate">{job.error ?? "This could not be finished."}</span>
      </p>
    );
  }

  return null;
}

/** JobProgress for whatever job a subject has: mount it under a row and it follows that row's work. */
export function SubjectJobProgress({ subject, className }: { subject: string; className?: string }) {
  return <JobProgress job={useJobForSubject(subject)} className={className} />;
}
