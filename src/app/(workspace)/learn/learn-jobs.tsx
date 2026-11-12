"use client";

import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import type { GenerationJobView } from "@/domains/jobs/state";

/** Every quiz and deck the learner has being made, above the lists they land in. */
export function LearnJobs({ initialJobs, kindPrefix }: { initialJobs: GenerationJobView[]; kindPrefix: string }) {
  const surface = useSurfaceJobs(initialJobs, { kindPrefix });
  if (surface.jobs.length === 0) return null;
  return (
    <section aria-labelledby="learn-jobs-title" className="panel mb-4 rounded-xl p-4">
      <h2 id="learn-jobs-title" className="font-medium">
        Being made
      </h2>
      <GenerationJobRows surface={surface} className="mt-3" />
    </section>
  );
}
