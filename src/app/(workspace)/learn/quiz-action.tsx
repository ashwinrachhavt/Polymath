"use client";

import { useState, useTransition } from "react";
import { GenerationJobRows, useSurfaceJobs } from "@/components/jobs/generation-job-rows";
import { trackGenerationJob } from "@/components/jobs/generation-jobs";
import { Button } from "@/components/ui/button";
import { WorkStatus } from "@/components/work-status";
import type { GenerationJobView } from "@/domains/jobs/state";
import { LEARNING_JOB_KIND_PREFIX, learningJobSubject } from "@/domains/learning/job-names";
import { generateQuizAction } from "./actions";

/*
 * Generate or regenerate one document's quiz. The click only hands the work
 * over: the quiz is made in the background, its row below says how that is
 * going, and the page re-reads itself when it is ready (latest ready wins).
 * `initialJobs` are this document's unfinished quiz jobs at render, so the
 * button stays held, and a failure stays visible, across a reload.
 */
export function GenerateQuizButton({
  documentId,
  initialJobs,
  label = "Generate quiz",
}: {
  documentId: string;
  initialJobs: GenerationJobView[];
  label?: string;
}) {
  const surface = useSurfaceJobs(initialJobs, {
    kindPrefix: LEARNING_JOB_KIND_PREFIX,
    subject: learningJobSubject.document(documentId),
  });
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-2">
      <Button
        type="button"
        size="sm"
        disabled={pending || surface.active}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await generateQuizAction({ documentId, idempotencyKey: crypto.randomUUID() }).catch(() => ({
              ok: false as const,
              error: "The request did not reach Polymath. Try again.",
            }));
            if (result.ok) trackGenerationJob(result.job);
            else setError(result.error);
          });
        }}
      >
        {pending ? "Starting…" : label}
      </Button>
      {error ? <WorkStatus state={{ phase: "failed", label: error }} /> : null}
      <GenerationJobRows surface={surface} />
    </span>
  );
}
