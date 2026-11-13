"use client";

import { JobsList, useJobActions, useLiveJobs } from "@/components/jobs/generation-job-rows";
import type { GenerationJobView } from "@/domains/jobs/state";

/*
 * The Activity page's "Background work" section: the same feed as the top
 * bar's jobs panel, rendered from the database and moved on by the stream.
 */
export function BackgroundWork({ initialJobs }: { initialJobs: GenerationJobView[] }) {
  const actions = useJobActions();
  const jobs = useLiveJobs(initialJobs, () => true, actions.dismissed);
  if (jobs.length === 0) return null;
  return (
    <section id="background-work" aria-labelledby="background-work-title" className="mb-6 scroll-mt-16">
      <h2 id="background-work-title" className="mb-3 text-sm font-medium">
        Background work
      </h2>
      <JobsList jobs={jobs} actions={actions} className="rounded-lg border border-border p-4" />
    </section>
  );
}
