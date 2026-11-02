/*
 * The read half of the change brief (Workbench D2): everything the run-detail
 * panel renders, loaded for one run. The write half is scripts/workbench/capture.ts;
 * this module only reads what capture wrote — checkpoint row, diff blob, the
 * linked project's stated outcome — and hands it to the pure builder. Every
 * absence stays honest: no checkpoint means no panel, and an unreadable diff
 * reports why instead of rendering as empty.
 */

import { and, desc, eq } from "drizzle-orm";
import { readBlob } from "@/integrations/object-store/object-store";
import { blobObjects } from "@/domains/audit/schema";
import { projects } from "@/domains/work/schema";
import { agentRuns, repoCheckpoints } from "@/domains/agents/schema";
import { buildChangeBriefData, type ChangeBriefData } from "@/domains/agents/change-brief";
import { projectSubjectOf } from "@/domains/agents/queries";
import { db } from "@/lib/db";

const DIFF_UNSTORED = "The stored diff is no longer retained.";
const DIFF_UNREADABLE = "The stored diff could not be read.";

export async function getRunChangeBrief(workspaceId: string, runId: string): Promise<ChangeBriefData | null> {
  const [checkpoint] = await db
    .select({
      id: repoCheckpoints.id,
      repoUrl: repoCheckpoints.repoUrl,
      baseCommitSha: repoCheckpoints.baseCommitSha,
      commitSha: repoCheckpoints.commitSha,
      decisionNote: repoCheckpoints.decisionNote,
      decisionStatus: repoCheckpoints.decisionStatus,
      testResults: repoCheckpoints.testResults,
      diffBlobId: repoCheckpoints.diffBlobId,
      createdAt: repoCheckpoints.createdAt,
    })
    .from(repoCheckpoints)
    // The run's latest checkpoint: re-capture appends, and the newest state is
    // what a reader opening the run wants to see.
    .where(and(eq(repoCheckpoints.workspaceId, workspaceId), eq(repoCheckpoints.runId, runId)))
    .orderBy(desc(repoCheckpoints.createdAt))
    .limit(1);
  if (!checkpoint) return null;

  const [diff, project] = await Promise.all([readDiffText(workspaceId, checkpoint.diffBlobId), linkedProject(workspaceId, runId)]);

  return buildChangeBriefData({
    checkpoint: {
      id: checkpoint.id,
      repoUrl: checkpoint.repoUrl,
      baseCommitSha: checkpoint.baseCommitSha,
      commitSha: checkpoint.commitSha,
      decisionNote: checkpoint.decisionNote,
      decisionStatus: checkpoint.decisionStatus,
      capturedAt: checkpoint.createdAt,
    },
    tests: checkpoint.testResults ?? null,
    diffText: diff.text,
    diffUnavailableReason: diff.reason,
    project,
  });
}

/**
 * Decode the checkpoint's stored diff bytes. The blob row is resolved scoped to
 * the workspace — the checkpoint can only point at its own workspace's blob —
 * and a failed read degrades the section rather than the page: a broken blob
 * must not take the run detail down with it.
 */
async function readDiffText(workspaceId: string, diffBlobId: string | null): Promise<{ text: string | null; reason: string | null }> {
  if (!diffBlobId) return { text: null, reason: DIFF_UNSTORED };
  const [blob] = await db
    .select({ storageKey: blobObjects.storageKey })
    .from(blobObjects)
    .where(and(eq(blobObjects.workspaceId, workspaceId), eq(blobObjects.id, diffBlobId)))
    .limit(1);
  if (!blob) return { text: null, reason: DIFF_UNSTORED };
  try {
    const bytes = await readBlob(blob.storageKey);
    // The diff is text/x-diff; a non-UTF-8 byte decodes to U+FFFD rather than throwing.
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes), reason: null };
  } catch (error) {
    // Surfaced, not swallowed: the panel shows the degraded line, the log carries the cause.
    console.error("workbench: failed to read checkpoint diff blob", error);
    return { text: null, reason: DIFF_UNREADABLE };
  }
}

/** The linked project's stated outcome, via the run's project subject. No subject, no section. */
async function linkedProject(workspaceId: string, runId: string): Promise<ChangeBriefData["project"]> {
  const [run] = await db.select({ subjects: agentRuns.subjects }).from(agentRuns).where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.id, runId))).limit(1);
  if (!run) return null;
  const subject = projectSubjectOf(run.subjects);
  if (!subject) return null;
  const [project] = await db
    .select({ name: projects.name, intendedOutcome: projects.intendedOutcome })
    .from(projects)
    .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, subject.id)))
    .limit(1);
  return project ?? null;
}
