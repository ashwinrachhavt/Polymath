"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import { trackGenerationJob } from "@/components/jobs/generation-jobs";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import type { GenerationJobView } from "@/domains/jobs/state";
import { crawlCaptureSiteAction } from "./actions";

/*
 * A link capture's site: the pages its crawl filed as child documents, the
 * crawl itself while it runs (live, from the jobs stream), and "Read the
 * whole site" for a capture that was read as one page. A finished crawl
 * re-reads the page (useSurfaceJobs), so the pages appear without a reload.
 */

export type CaptureSitePage = { documentId: string; title: string; sourceUrl: string | null };

export function CaptureSite({
  captureId,
  pages,
  initialJobs,
}: {
  captureId: string;
  pages: CaptureSitePage[];
  initialJobs: GenerationJobView[];
}) {
  const surface = useSurfaceJobs(initialJobs, { kindPrefix: "knowledge.crawl", subject: `capture:${captureId}` });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function readSite() {
    setError(null);
    startTransition(async () => {
      const result = await crawlCaptureSiteAction({ captureId }).catch(() => null);
      if (!result?.ok) setError(result?.error ?? "The request did not reach Polymath. Try again.");
      else if (result.job) trackGenerationJob(result.job);
    });
  }

  return (
    <section aria-labelledby={`site-${captureId}`} className="mt-6 max-w-[70ch]">
      <h3 id={`site-${captureId}`} className="mb-2 text-sm font-medium">
        Pages from this site
      </h3>
      <GenerationJobRows surface={surface} className="mb-3 text-body-dense" />
      {pages.length > 0 ? (
        <ol className="space-y-1 text-body-dense">
          {pages.map((page) => (
            <li key={page.documentId} className="truncate">
              <Link href={`/polymath/knowledge?doc=${page.documentId}`} className="underline-offset-4 hover:underline">
                {page.title}
              </Link>
            </li>
          ))}
        </ol>
      ) : !surface.active && surface.jobs.length === 0 ? (
        <div>
          <p className="text-body-dense text-muted-foreground">
            Only this page was read. Read the site around it to add up to 25 of its pages to your library.
          </p>
          <Button className="mt-2" size="sm" variant="outline" disabled={pending} onClick={readSite}>
            Read the whole site
          </Button>
        </div>
      ) : null}
      {error ? <WorkStatus state={{ phase: "failed", label: error }} className="mt-2 text-xs" /> : null}
    </section>
  );
}
