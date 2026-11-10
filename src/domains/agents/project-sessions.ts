import { and, eq } from "drizzle-orm";

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

/** One imported session with its full summary, or null when not in this workspace. */
export async function getProjectSession(
  auth: AuthContext,
  sessionId: string,
): Promise<
  | (ProjectSessionRow & {
      cwd: string;
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
    cwd: row.cwd,
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
