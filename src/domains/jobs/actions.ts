"use server";

import { z } from "zod";
import { actionError } from "@/lib/action-error";
import { getAuthContext } from "@/lib/auth";
import { requireRole } from "@/lib/auth/guards";
import { cancelGenerationJob, dismissGenerationJob, queuedGenerationJobAttempt, retryGenerationJob } from "./commands";
import { kickGenerationJob } from "./kick";
import { listRecentGenerationJobs } from "./queries";
import type { GenerationJobView } from "./state";

/*
 * What a person can do to their own generation job from any surface that
 * lists it. Every verb answers with a typed union; nothing thrown reaches the
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

export async function cancelGenerationJobAction(
  jobId: string,
): Promise<{ ok: true; job: GenerationJobView | null } | { ok: false; error: string }> {
  if (!jobIdSchema.safeParse(jobId).success) return { ok: true, job: null };
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    // Null: it settled before the click landed; the stream shows how.
    return { ok: true, job: await cancelGenerationJob(auth, jobId) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not stop that.") };
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

/**
 * Starts a job that has waited too long in the queue. Where no outbox worker
 * runs between requests (the deployed app drains the outbox once a day), the
 * run started at submit is the only prompt one; if that never happened, this
 * is how a watching page gets the work going. Safe to call for any job: the
 * claim runs each attempt once.
 */
export async function startWaitingGenerationJobAction(jobId: string): Promise<void> {
  if (!jobIdSchema.safeParse(jobId).success) return;
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    const attempt = await queuedGenerationJobAttempt(auth, jobId);
    if (attempt !== null) kickGenerationJob({ jobId, attempt });
  } catch (error) {
    actionError(error, "Could not start a waiting job.");
  }
}

/** The person's recent background work, for the jobs panel when it opens. */
export async function listRecentGenerationJobsAction(): Promise<
  { ok: true; jobs: GenerationJobView[] } | { ok: false; error: string }
> {
  try {
    const auth = await getAuthContext();
    requireRole(auth, "member");
    return { ok: true, jobs: await listRecentGenerationJobs(auth) };
  } catch (error) {
    return { ok: false, error: actionError(error, "Could not read your background work.") };
  }
}
