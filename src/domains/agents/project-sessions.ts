import { and, desc, eq } from "drizzle-orm";

import { cwdMatchesProjectRoot } from "@/lib/agent-artifacts/cwd-match";
import type { SessionSummary } from "@/lib/agent-artifacts/types";
import { db } from "@/lib/db";
import type { AuthContext } from "@/lib/auth";

import { importedAgentSessions } from "./schema";

/*
 * The project-side read of imported agent sessions (Workbench D3). Sessions
 * attach to a project by matching their transcript `cwd` against the
 * project's local repo path (notebooks.repo_path) — the fallback the re-spec
 * names for attachment, and here the primary mechanism, because
 * `artifact_links` requires an artifacts row on its left side and an imported
 * session is not an artifact (its bytes live in audit.blob_objects, its
 * summary in imported_agent_sessions; `project` is a valid target kind but
 * there is nothing to put at artifactId). No link rows are written; the
 * cwd-match query is the attachment.
 */

/** One listed session on the project page: the columns the row renders. */
export type ProjectSessionRow = {
  id: string;
  source: SessionSummary["source"];
  externalSessionId: string;
  aiTitle: string | null;
  startedAt: Date | null;
  lastActivityAt: Date | null;
  promptCount: number;
  fileCount: number;
  commandCount: number;
  failureCount: number;
};

/**
 * The workspace's imported sessions whose cwd belongs to `repoPath`, newest
 * activity first. The tenant column filters the rows; the cwd match runs in
 * the pure helper above so every consumer shares one definition of "belongs
 * to this project". The candidate fetch is capped at what a scan can have
 * written (SCAN_LIMITS caps session files per scan).
 */
export async function listProjectSessions(
  auth: AuthContext,
  repoPath: string,
  limit = 100,
): Promise<ProjectSessionRow[]> {
  const rows = await db
    .select({
      id: importedAgentSessions.id,
      cwd: importedAgentSessions.cwd,
      source: importedAgentSessions.source,
      externalSessionId: importedAgentSessions.externalSessionId,
      startedAt: importedAgentSessions.startedAt,
      lastActivityAt: importedAgentSessions.lastActivityAt,
      summary: importedAgentSessions.summary,
    })
    .from(importedAgentSessions)
    .where(eq(importedAgentSessions.workspaceId, auth.workspaceId))
    .orderBy(desc(importedAgentSessions.lastActivityAt), desc(importedAgentSessions.createdAt))
    .limit(limit);
  return rows
    .filter((row) => cwdMatchesProjectRoot(row.cwd, repoPath))
    .map((row) => ({
      id: row.id,
      source: row.source,
      externalSessionId: row.externalSessionId,
      aiTitle: row.summary.aiTitle ?? null,
      startedAt: row.startedAt,
      lastActivityAt: row.lastActivityAt,
      promptCount: row.summary.humanPrompts.length,
      fileCount: row.summary.filesTouched.length,
      commandCount: row.summary.commandsRun.length,
      failureCount: row.summary.failures.length,
    }));
}

/** One imported session with its full summary, or null when not in this workspace. */
export async function getProjectSession(
  auth: AuthContext,
  sessionId: string,
): Promise<
  | (ProjectSessionRow & {
      summary: SessionSummary;
      decisionNote: string | null;
      decisionStatus: "recorded" | "inferred";
    })
  | null
> {
  const [row] = await db
    .select()
    .from(importedAgentSessions)
    .where(and(eq(importedAgentSessions.id, sessionId), eq(importedAgentSessions.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    externalSessionId: row.externalSessionId,
    aiTitle: row.summary.aiTitle ?? null,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    promptCount: row.summary.humanPrompts.length,
    fileCount: row.summary.filesTouched.length,
    commandCount: row.summary.commandsRun.length,
    failureCount: row.summary.failures.length,
    summary: row.summary,
    decisionNote: row.decisionNote,
    decisionStatus: row.decisionStatus,
  };
}
