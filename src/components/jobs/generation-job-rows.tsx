"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import {
  forgetGenerationJob,
  jobWorkState,
  trackGenerationJob,
  useGenerationJobs,
} from "@/components/jobs/generation-jobs";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import { dismissGenerationJobAction, retryGenerationJobAction } from "@/domains/jobs/actions";
import { isSettled, jobSignature, type GenerationJobView } from "@/domains/jobs/state";

/*
 * What is being made, shown on the surface it will land on. Any page that
 * starts background generation uses these two pieces, so waiting, ready,
 * failed and retry read the same everywhere.
 *
 * `initialJobs` is what the database held when the page rendered, so a person
 * who left and came back sees the truth. The jobs stream then moves each row
 * from waiting to ready or failed without the page asking, and the page's own
 * server data is re-read once per job that settles. A failed row stays, with
 * its reason and a retry, until its maker dismisses it. A row that became
 * ready while the page was open stays as a link to the result; on the next
 * visit the result is simply where it belongs.
 */

export type SurfaceJobs = {
  /** Newest first. */
  jobs: GenerationJobView[];
  /** True while any of them is still waiting or being made. */
  active: boolean;
  retry: (job: GenerationJobView) => void;
  dismiss: (job: GenerationJobView) => void;
  busy: boolean;
  actionError: string | null;
};

/** The jobs one surface cares about: a kind prefix and, when given, one subject (null: jobs with none). */
export function useSurfaceJobs(
  initialJobs: GenerationJobView[],
  filter: { kindPrefix: string; subject?: string | null },
): SurfaceJobs {
  const router = useRouter();
  const live = useGenerationJobs();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const [busy, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const byId = new Map(initialJobs.map((job) => [job.id, job]));
  for (const job of live.values()) {
    if (!job.kind.startsWith(filter.kindPrefix)) continue;
    if (filter.subject !== undefined && job.subject !== filter.subject) continue;
    const rendered = byId.get(job.id);
    // The stream's state wins unless the page was rendered after it.
    if (!rendered || rendered.updatedAt <= job.updatedAt) byId.set(job.id, job);
  }
  const jobs = [...byId.values()]
    .filter((job) => !dismissed.has(job.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

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

  function retry(job: GenerationJobView) {
    setActionError(null);
    startTransition(async () => {
      const result = await retryGenerationJobAction(job.id).catch(() => null);
      if (result?.ok) trackGenerationJob(result.job);
      else setActionError(result?.error ?? "The request did not reach Polymath. Try again.");
    });
  }

  function dismiss(job: GenerationJobView) {
    setActionError(null);
    startTransition(async () => {
      const result = await dismissGenerationJobAction(job.id).catch(() => null);
      if (!result?.ok) {
        setActionError(result?.error ?? "The request did not reach Polymath. Try again.");
        return;
      }
      setDismissed((current) => new Set(current).add(job.id));
      forgetGenerationJob(job.id);
    });
  }

  return { jobs, active: jobs.some((job) => !isSettled(job.status)), retry, dismiss, busy, actionError };
}

/** One row per job. Renders nothing when there are none. */
export function GenerationJobRows({ surface, className }: { surface: SurfaceJobs; className?: string }) {
  const pathname = usePathname();
  if (surface.jobs.length === 0) return null;
  return (
    <div className={className}>
      <ul className="divide-y divide-border">
        {surface.jobs.map((job) => (
          <li
            key={job.id}
            data-job-status={job.status}
            className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{job.title}</p>
              <WorkStatus state={jobWorkState(job)} className="text-xs" />
            </div>
            {/* A result that lands on this very page needs no link to it. */}
            {job.status === "ready" && job.href && job.href !== pathname ? (
              <Link href={job.href} className="shrink-0 text-sm underline underline-offset-4">
                Open
              </Link>
            ) : null}
            {job.status === "failed" ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" disabled={surface.busy} onClick={() => surface.dismiss(job)}>
                  Dismiss
                </Button>
                <Button size="sm" disabled={surface.busy} onClick={() => surface.retry(job)}>
                  Try again
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {surface.actionError ? (
        <WorkStatus state={{ phase: "failed", label: surface.actionError }} className="mt-2 text-xs" />
      ) : null}
    </div>
  );
}
