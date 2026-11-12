"use server";

import { z } from "zod";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { dismissGenerationJob, retryGenerationJob } from "./commands";
import { kickGenerationJob } from "./kick";
import type { GenerationJobView } from "./state";

/*
 * What a person can do to their own generation job from any surface that
 * lists it. Both verbs answer with a typed union; nothing thrown reaches the
 * client.
 */

const jobIdSchema = z.uuid();

export async function retryGenerationJobAction(
  jobId: string,
): Promise<{ ok: true; job: GenerationJobView } | { ok: false; error: string }> {
  if (!jobIdSchema.safeParse(jobId).success) return { ok: false, error: "That is no longer here to retry." };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const job = await retryGenerationJob(auth, jobId);
    if (!job) return { ok: false, error: "That is no longer here to retry." };
    kickGenerationJob({ jobId: job.id, attempt: job.attempt });
    return { ok: true, job };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not start that again.") };
  }
}

export async function dismissGenerationJobAction(jobId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!jobIdSchema.safeParse(jobId).success) return { ok: true };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    await dismissGenerationJob(auth, jobId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not dismiss that.") };
  }
}
