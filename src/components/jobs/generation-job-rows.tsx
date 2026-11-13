"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "cn";
import {
  forgetGenerationJob,
  jobWorkState,
  trackGenerationJob,
  useGenerationJobs,
} from "@/components/jobs/generation-jobs";
import { JobMark } from "@/components/jobs/job-mark";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import {
  cancelGenerationJobAction,
  dismissGenerationJobAction,
  retryGenerationJobAction,
} from "@/domains/jobs/actions";
import { isSettled, jobSignature, progressFraction, type GenerationJobView } from "@/domains/jobs/state";

/*
 * Jobs as rows. One row component and one set of verbs serve every place a
 * job is listed: the surface it will land on (useSurfaceJobs), the top bar's
 * jobs panel and the Activity page (JobsList), so waiting, progress, ready,
 * failed, stop and retry read the same everywhere.
 *
 * `initialJobs` is what the database held when the page rendered, so a person
 * who left and came back sees the truth. The jobs stream then moves each row
 * without the page asking. A failed row stays, with its reason and a retry,
 * until its maker dismisses it.
 */

export type JobActions = {
  retry: (job: GenerationJobView) => void;
  dismiss: (job: GenerationJobView) => void;
  cancel: (job: GenerationJobView) => void;
  /** Jobs dismissed from this tab; lists leave them out. */
  dismissed: ReadonlySet<string>;
  busy: boolean;
  actionError: string | null;
};

const UNREACHED = "The request did not reach Polymath. Try again.";

/** The verbs a person has over their own jobs, each answered through the stream's store. */
export function useJobActions(): JobActions {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [busy, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  function retry(job: GenerationJobView) {
    setActionError(null);
    startTransition(async () => {
      const result = await retryGenerationJobAction(job.id).catch(() => null);
      if (result?.ok) trackGenerationJob(result.job);
      else setActionError(result?.error ?? UNREACHED);
    });
  }

  function cancel(job: GenerationJobView) {
    setActionError(null);
    startTransition(async () => {
      const result = await cancelGenerationJobAction(job.id).catch(() => null);
      if (!result?.ok) setActionError(result?.error ?? UNREACHED);
      else if (result.job) trackGenerationJob(result.job);
    });
  }

  function dismiss(job: GenerationJobView) {
    setActionError(null);
    startTransition(async () => {
      const result = await dismissGenerationJobAction(job.id).catch(() => null);
      if (!result?.ok) {
        setActionError(result?.error ?? UNREACHED);
        return;
      }
      setDismissed((current) => new Set(current).add(job.id));
      forgetGenerationJob(job.id);
    });
  }

  return { retry, dismiss, cancel, dismissed, busy, actionError };
}

/** The rendered rows overlaid with what the stream has said since. Newest first. */
export function useLiveJobs(
  initialJobs: GenerationJobView[],
  include: (job: GenerationJobView) => boolean,
  dismissed: ReadonlySet<string>,
): GenerationJobView[] {
  const live = useGenerationJobs();
  const byId = new Map(initialJobs.map((job) => [job.id, job]));
  for (const job of live.values()) {
    if (!include(job)) continue;
    const rendered = byId.get(job.id);
    // The stream's state wins unless the page was rendered after it.
    if (!rendered || rendered.updatedAt <= job.updatedAt) byId.set(job.id, job);
  }
  return [...byId.values()]
    .filter((job) => !dismissed.has(job.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type SurfaceJobs = JobActions & {
  /** Newest first. */
  jobs: GenerationJobView[];
  /** True while any of them is still waiting or being made. */
  active: boolean;
};

/** The jobs one surface cares about: a kind prefix and, when given, one subject (null: jobs with none). */
export function useSurfaceJobs(
  initialJobs: GenerationJobView[],
  filter: { kindPrefix: string; subject?: string | null },
): SurfaceJobs {
  const router = useRouter();
  const actions = useJobActions();
  const jobs = useLiveJobs(
    initialJobs,
    (job) =>
      job.kind.startsWith(filter.kindPrefix) &&
      (filter.subject === undefined || job.subject === filter.subject) &&
      // A stop is the person's own decision; the surface forgets it.
      job.status !== "cancelled",
    actions.dismissed,
  );

  // A job that settles changes what the page lists (a new quiz, new due cards): re-read once per settle.
  const settledKey = jobs
    .filter((job) => isSettled(job.status))
    .map((job) => `${job.id}:${jobSignature(job)}`)
    .join(",");
  const lastSettledKey = useRef(settledKey);
  useEffect(() => {
    if (lastSettledKey.current === settledKey) return;
    lastSettledKey.current = settledKey;
    router.refresh();
  }, [settledKey, router]);

  return { ...actions, jobs, active: jobs.some((job) => !isSettled(job.status)) };
}

/** One job: its mark, title, live step, progress and the verbs its state allows. */
function JobRow({ job, actions }: { job: GenerationJobView; actions: JobActions }) {
  const pathname = usePathname();
  const fraction = progressFraction(job.progress);
  return (
    <li data-job-status={job.status} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <JobMark status={job.status} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{job.title}</p>
        <WorkStatus state={jobWorkState(job)} className="text-xs" />
        {job.status === "running" ? <ProgressBar fraction={fraction} /> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* A result that lands on this very page needs no link to it. */}
        {job.status === "ready" && job.href && job.href !== pathname ? (
          <Link href={job.href} className="text-sm underline underline-offset-4">
            Open
          </Link>
        ) : null}
        {job.status === "queued" || job.status === "running" ? (
          <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => actions.cancel(job)}>
            Stop
          </Button>
        ) : null}
        {job.status === "failed" || job.status === "cancelled" ? (
          <>
            <Button size="sm" variant="ghost" disabled={actions.busy} onClick={() => actions.dismiss(job)}>
              Dismiss
            </Button>
            <Button size="sm" disabled={actions.busy} onClick={() => actions.retry(job)}>
              Try again
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function ProgressBar({ fraction }: { fraction: number | null }) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full bg-foreground/60 transition-[width] duration-300 ease-out",
          fraction === null && "job-progress-indeterminate w-1/3",
        )}
        style={fraction === null ? undefined : { width: `${Math.max(4, fraction * 100)}%` }}
      />
    </div>
  );
}

/** A list of jobs with their verbs. Renders nothing when there are none. */
export function JobsList({
  jobs,
  actions,
  className,
}: {
  jobs: GenerationJobView[];
  actions: JobActions;
  className?: string;
}) {
  if (jobs.length === 0) return null;
  return (
    <div className={className}>
      <ul className="divide-y divide-border">
        {jobs.map((job) => (
          <JobRow key={job.id} job={job} actions={actions} />
        ))}
      </ul>
      {actions.actionError ? (
        <WorkStatus state={{ phase: "failed", label: actions.actionError }} className="mt-2 text-xs" />
      ) : null}
    </div>
  );
}

/** A surface's own jobs. Renders nothing when there are none. */
export function GenerationJobRows({ surface, className }: { surface: SurfaceJobs; className?: string }) {
  return <JobsList jobs={surface.jobs} actions={surface} className={className} />;
}
