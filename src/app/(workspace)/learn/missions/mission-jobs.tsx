"use client";

import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import type { GenerationJobView } from "@/domains/jobs/state";

/** The wait for one Mission's concepts, written through the shared job row. */
export function MissionJobs({ initialJobs, subject }: { initialJobs: GenerationJobView[]; subject: string }) {
  const surface = useSurfaceJobs(initialJobs, { kindPrefix: "learning.mission", subject });
  if (surface.jobs.length === 0) return null;
  return (
    <section aria-labelledby="mission-jobs-title" className="panel rounded-xl p-4">
      <h2 id="mission-jobs-title" className="font-medium">
        Being made
      </h2>
      <GenerationJobRows surface={surface} className="mt-3" />
    </section>
  );
}
