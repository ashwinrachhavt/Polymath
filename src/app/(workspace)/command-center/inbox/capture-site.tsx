"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ExternalLink, GraduationCap, Lightbulb } from "lucide-react";
import { MakeLearningDialog } from "@/app/(workspace)/learn/make-learning-dialog";
import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import { trackGenerationJob } from "@/components/jobs/generation-jobs";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useZettelize, useZettelJobs } from "@/components/zettelize/zettel-jobs";
import { MAX_ZETTELIZE_SOURCES, zettelJobSubject } from "@/domains/capture/zettel-job-names";
import { WorkStatus } from "@/components/work-status";
import type { GenerationJobView } from "@/domains/jobs/state";
import { crawlCaptureSiteAction } from "./actions";

/*
 * A link capture's site: the pages its crawl filed as child documents, the
 * crawl itself while it runs (live, from the jobs stream), and "Read the
 * whole site" for a capture that was read as one page. A finished crawl
 * re-reads the page (useSurfaceJobs), so the pages appear without a reload.
 */

export type CaptureSitePage = {
  documentId: string;
  title: string;
  sourceUrl: string | null;
  /** Where the page opens to be read: the inbox's reader, never the Document Vault. */
  readHref: string;
};

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
  const zettel = useZettelize();
  const [learning, setLearning] = useState<CaptureSitePage[] | null>(null);
  // The ideas jobs this list started, shown here and not the whole workspace's.
  const subjects = new Set(pages.map((page) => zettelJobSubject({ kind: "document", id: page.documentId })));
  const ideasAll = useZettelJobs([]);
  const ideaJobs = {
    ...ideasAll,
    jobs: ideasAll.jobs.filter((job) => job.subject !== null && subjects.has(job.subject)),
  };
  const working = ideaJobs.jobs.some((job) => job.status === "queued" || job.status === "running");

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
        <>
          <div className="mb-2 flex items-center gap-1">
            <IconButton
              size="icon-sm"
              label={`Zettelize ${pages.length > MAX_ZETTELIZE_SOURCES ? `the first ${MAX_ZETTELIZE_SOURCES} pages` : "all pages"}`}
              icon={<Lightbulb aria-hidden />}
              disabled={zettel.pending || working}
              onClick={() =>
                zettel.zettelize(
                  pages
                    .slice(0, MAX_ZETTELIZE_SOURCES)
                    .map((page) => ({ kind: "document" as const, id: page.documentId })),
                )
              }
            />
            <IconButton
              size="icon-sm"
              label="Make flashcards or a quiz from these pages"
              icon={<GraduationCap aria-hidden />}
              onClick={() => setLearning(pages)}
            />
            <span className="text-muted-foreground ml-1 text-xs tabular-nums">{pages.length} pages</span>
          </div>
          <ol className="divide-border divide-y text-body-dense">
            {pages.map((page) => (
              <li key={page.documentId} className="flex items-center gap-2 py-1.5">
                <Link href={page.readHref} className="min-w-0 flex-1 truncate underline-offset-4 hover:underline">
                  {page.title}
                </Link>
                <IconButton
                  size="icon-xs"
                  label="Zettelize this page"
                  icon={<Lightbulb aria-hidden />}
                  disabled={zettel.pending || working}
                  onClick={() => zettel.zettelize([{ kind: "document", id: page.documentId }])}
                />
                <IconButton
                  size="icon-xs"
                  label="Make flashcards or a quiz from this page"
                  icon={<GraduationCap aria-hidden />}
                  onClick={() => setLearning([page])}
                />
                {page.sourceUrl ? (
                  <IconButton
                    size="icon-xs"
                    label="Open the original page"
                    icon={<ExternalLink aria-hidden />}
                    href={page.sourceUrl}
                    target="_blank"
                  />
                ) : null}
              </li>
            ))}
          </ol>
          {zettel.error ? (
            <WorkStatus state={{ phase: "failed", label: zettel.error }} className="mt-2 text-xs" />
          ) : null}
          <GenerationJobRows surface={ideaJobs} className="mt-3 text-body-dense" />
          <MakeLearningDialog
            open={learning !== null}
            onOpenChange={(open) => (open ? undefined : setLearning(null))}
            initialSources={(learning ?? []).map((page) => ({
              type: "document" as const,
              id: page.documentId,
              title: page.title,
              ready: true,
            }))}
          />
        </>
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
