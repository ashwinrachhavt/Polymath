"use client";

import { useState, useTransition } from "react";
import { trackGenerationJob } from "@/components/jobs/generation-jobs";
import { useSurfaceJobs, type SurfaceJobs } from "@/components/jobs/generation-job-rows";
import { zettelizeAction } from "@/domains/capture/zettel-actions";
import { ZETTEL_JOB_KIND_PREFIX, type ZettelSource } from "@/domains/capture/zettel-job-names";
import type { GenerationJobView } from "@/domains/jobs/state";
import { randomId } from "@/lib/random-id";

/*
 * Zettelize from a surface: start the jobs, and show them where they were
 * started. The click returns as soon as the jobs are accepted; the rows below
 * move from waiting to ready (with a link to Ideas) or failed (with a retry)
 * on the jobs stream, and the shell announces each one wherever the person is.
 */

export function useZettelize() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);

  function zettelize(sources: ZettelSource[], onStarted?: () => void) {
    setError(null);
    setSkipped(0);
    startTransition(async () => {
      const result = await zettelizeAction({ sources, idempotencyKey: randomId() }).catch(() => null);
      if (!result) {
        setError("The request did not reach Polymath. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.message);
        return;
      }
      for (const job of result.jobs) trackGenerationJob(job);
      setSkipped(result.skipped);
      onStarted?.();
    });
  }

  return { zettelize, pending, error, skipped };
}

/** The zettelize jobs this surface shows; `subject` narrows to one source's job. Render with GenerationJobRows. */
export function useZettelJobs(initialJobs: GenerationJobView[], subject?: string): SurfaceJobs {
  // The stream's jobs are filtered by subject inside useSurfaceJobs; the page's own list is narrowed here.
  const mine = subject === undefined ? initialJobs : initialJobs.filter((job) => job.subject === subject);
  return useSurfaceJobs(mine, { kindPrefix: ZETTEL_JOB_KIND_PREFIX, subject });
}
