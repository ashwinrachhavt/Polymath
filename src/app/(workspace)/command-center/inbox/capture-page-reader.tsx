"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ExternalLink, GraduationCap, Lightbulb } from "lucide-react";
import { MakeLearningDialog } from "@/app/(workspace)/learn/make-learning-dialog";
import { GenerationJobRows } from "@/components/jobs/generation-job-rows";
import { IconButton } from "@/components/ui/icon-button";
import { WorkStatus } from "@/components/work-status";
import type { CaptureChildPage } from "@/domains/capture/children";
import { zettelJobSubject } from "@/domains/capture/zettel-job-names";
import { useZettelize, useZettelJobs } from "@/components/zettelize/zettel-jobs";
import { CaptureBody } from "./capture-body";

/*
 * One page of a link capture's site, opened to read in the inbox's detail
 * pane: its text, where it came from, a way back to the site's list, and what
 * can be done with it (ideas, flashcards or a quiz, the original). The page is
 * a library document, but the Document Vault's review screen is for files a
 * person filed (fields, document type, ledger), so it is never where a crawled
 * page opens.
 */

export function CapturePageReader({
  page,
  backHref,
  siteTitle,
  zettelProviderReady,
}: {
  page: CaptureChildPage;
  backHref: string;
  siteTitle: string;
  zettelProviderReady: boolean;
}) {
  const zettel = useZettelize();
  const subject = zettelJobSubject({ kind: "document", id: page.documentId });
  const zettelSurface = useZettelJobs([], subject);
  const [learningOpen, setLearningOpen] = useState(false);

  return (
    <article aria-label={page.title} className="max-w-[70ch]">
      <Link href={backHref} className="text-muted-foreground inline-flex items-center gap-1 text-xs hover:underline">
        <ArrowLeft aria-hidden className="size-3.5" />
        All pages from {siteTitle}
      </Link>

      <header className="mt-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg leading-snug font-medium">{page.title}</h2>
          {page.sourceUrl ? <p className="text-muted-foreground mt-0.5 truncate text-xs">{page.sourceUrl}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton
            size="icon-sm"
            label="Zettelize into Ideas"
            icon={<Lightbulb aria-hidden />}
            disabled={zettel.pending || zettelSurface.active || !page.text || !zettelProviderReady}
            onClick={() => zettel.zettelize([{ kind: "document", id: page.documentId }])}
          />
          <IconButton
            size="icon-sm"
            label="Make flashcards or a quiz"
            icon={<GraduationCap aria-hidden />}
            disabled={!page.text}
            onClick={() => setLearningOpen(true)}
          />
          {page.sourceUrl ? (
            <IconButton
              size="icon-sm"
              label="Open the original page"
              icon={<ExternalLink aria-hidden />}
              href={page.sourceUrl}
              target="_blank"
            />
          ) : null}
        </div>
      </header>

      <MakeLearningDialog
        open={learningOpen}
        onOpenChange={setLearningOpen}
        initialSources={[{ type: "document", id: page.documentId, title: page.title, ready: true }]}
      />

      {zettel.error ? <WorkStatus state={{ phase: "failed", label: zettel.error }} className="mt-3" /> : null}
      <GenerationJobRows surface={zettelSurface} className="mt-3 text-body-dense" />

      <div className="mt-6">
        {page.text ? (
          <>
            <CaptureBody
              captureId={page.documentId}
              version={0}
              text={page.text}
              label={`The text of ${page.title}`}
              editable={false}
            />
            {page.shortened ? (
              <p className="text-muted-foreground mt-3 text-xs">This page is long, so only its start is shown here.</p>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground text-body-dense">
            This page&apos;s text could not be loaded. Open the original to read it.
          </p>
        )}
      </div>
    </article>
  );
}
