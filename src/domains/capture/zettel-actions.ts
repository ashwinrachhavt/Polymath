"use server";

import { z } from "zod";
import { kickGenerationJob } from "@/domains/jobs/kick";
import type { GenerationJobView } from "@/domains/jobs/state";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { requestZettelJobs } from "./zettel-generation";
import { MAX_ZETTELIZE_SOURCES } from "./zettel-job-names";

/*
 * Zettelize from any surface: one capture or document from its own page, or a
 * selection from the inbox or the Document Vault. The action only accepts the
 * work - one generation job per source - and returns at once; the jobs stream
 * carries each job to ready or failed and the shell announces it.
 *
 * The client sends one idempotency key per click: a double-submit returns the
 * first jobs and queues nothing new.
 */

export type ZettelizeResult = { ok: true; jobs: GenerationJobView[]; skipped: number } | { ok: false; message: string };

const input = z.object({
  sources: z
    .array(z.object({ kind: z.enum(["capture", "document"]), id: z.uuid() }))
    .min(1)
    .max(MAX_ZETTELIZE_SOURCES),
  idempotencyKey: z.uuid(),
});

export async function zettelizeAction(raw: z.input<typeof input>): Promise<ZettelizeResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        raw?.sources?.length > MAX_ZETTELIZE_SOURCES
          ? `Zettelize up to ${MAX_ZETTELIZE_SOURCES} at a time.`
          : "That request was malformed. Reload and try again.",
    };
  }
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const outcome = await requestZettelJobs(auth, parsed.data);
    if (outcome.jobs.length === 0) {
      return {
        ok: false,
        message: "Nothing selected has text to read. Archived and already-filed items are left out.",
      };
    }
    for (const job of outcome.created) kickGenerationJob({ jobId: job.id, attempt: job.attempt });
    return { ok: true, jobs: outcome.jobs, skipped: outcome.skipped };
  } catch (error) {
    return { ok: false, message: actionError(error, "Zettelize did not start. Try again.") };
  }
}
