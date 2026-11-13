"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Layers } from "lucide-react";
import { useGenerationJobs } from "@/components/jobs/generation-jobs";
import { JobsList, useJobActions, useLiveJobs } from "@/components/jobs/generation-job-rows";
import { JobMark } from "@/components/jobs/job-mark";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { WorkStatus } from "@/components/work-status";
import { listRecentGenerationJobsAction } from "@/domains/jobs/actions";
import { isSettled, type GenerationJobView } from "@/domains/jobs/state";

/*
 * The top bar's window onto background work. The button turns while anything
 * the person started is running, shows how many, and when the last one
 * finishes its arc closes into a check for a moment before it rests. It opens
 * a panel listing running and recent jobs with their live step and verbs.
 *
 * Everything here reads the tab's one jobs store (GenerationJobsMount feeds
 * it from the stream). The panel adds the settled jobs the stream does not
 * replay, read once each time it opens.
 */

const DONE_MARK_MS = 2_400;

export function JobsIndicator() {
  const pathname = usePathname();
  const live = useGenerationJobs();
  const running = [...live.values()].filter((job) => !isSettled(job.status));
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<{ jobs: GenerationJobView[]; error: string | null }>({ jobs: [], error: null });
  const actions = useJobActions();
  const jobs = useLiveJobs(recent.jobs, () => true, actions.dismissed);

  // The moment the last running job settles, show how it ended, then rest.
  // Adjusted during render (the React-recommended way to react to a change).
  const [justSettled, setJustSettled] = useState<GenerationJobView | null>(null);
  const [runningBefore, setRunningBefore] = useState(running.length);
  if (runningBefore !== running.length) {
    setRunningBefore(running.length);
    if (runningBefore > 0 && running.length === 0) {
      const last = [...live.values()]
        .filter((job) => isSettled(job.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      if (last) setJustSettled(last);
    }
  }
  useEffect(() => {
    if (!justSettled) return;
    const timer = setTimeout(() => setJustSettled(null), DONE_MARK_MS);
    return () => clearTimeout(timer);
  }, [justSettled]);

  // A route change underneath the panel is a handoff (an Open link), not a reason to keep it up.
  const [renderedPath, setRenderedPath] = useState(pathname);
  if (renderedPath !== pathname) {
    setRenderedPath(pathname);
    setOpen(false);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    void listRecentGenerationJobsAction()
      .catch(() => ({ ok: false as const, error: "Your background work could not be read. Try again." }))
      .then((result) => setRecent(result.ok ? { jobs: result.jobs, error: null } : { jobs: [], error: result.error }));
  }

  const label =
    running.length > 0
      ? `Background work: ${running.length} running`
      : justSettled
        ? `Background work: ${justSettled.title} ${justSettled.status === "ready" ? "is done" : "stopped"}`
        : "Background work";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="sm" aria-label={label} title={label} data-jobs-indicator className="gap-1.5 px-2">
          {running.length > 0 ? (
            <>
              <JobMark status="running" />
              <span className="text-xs tabular-nums">{running.length}</span>
            </>
          ) : justSettled ? (
            <JobMark status={justSettled.status} />
          ) : (
            <Layers aria-hidden className="size-4" />
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle>Background work</SheetTitle>
          <SheetDescription>What you started. It keeps going when you leave the page.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {recent.error ? (
            <WorkStatus state={{ phase: "failed", label: recent.error }} className="mb-3 text-xs" />
          ) : null}
          {jobs.length === 0 ? (
            <p className="text-body-dense text-muted-foreground">Nothing is running, and nothing finished this week.</p>
          ) : (
            <JobsList jobs={jobs} actions={actions} />
          )}
        </div>
        <div className="border-t border-border p-4">
          <Link href="/activity#background-work" className="text-sm underline underline-offset-4">
            See it on Activity
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
