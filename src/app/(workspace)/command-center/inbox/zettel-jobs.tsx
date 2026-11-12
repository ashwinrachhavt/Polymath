"use client";

import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";

/*
 * The zettelize jobs a click just started, live from the jobs stream: each
 * capture's step ("Reading it", "Writing zettels"), then how many cards it
 * made, with a retry where one failed. `subject` narrows to one capture.
 */
export function ZettelJobs({ captureId }: { captureId?: string }) {
  const surface = useSurfaceJobs([], {
    kindPrefix: "capture.zettelize",
    ...(captureId ? { subject: `capture:${captureId}` } : {}),
  });
  return <GenerationJobRows surface={surface} className="w-full text-body-dense" />;
}
