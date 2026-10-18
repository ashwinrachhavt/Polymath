import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRuns } from "./schema";

/*
 * A run's frozen policy snapshot, read back for the tools that must honour it.
 * Scoped by workspace as well as run: a run id from another tenant and a run
 * that does not exist return the same null, because the difference is not the
 * caller's to learn.
 */
export async function getRunPolicySnapshot(
  runId: string,
  workspaceId: string,
): Promise<unknown | null> {
  const [run] = await db
    .select({ policySnapshot: agentRuns.policySnapshot })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return run?.policySnapshot ?? null;
}

/*
 * The eve side resolves its run through the session reference, not the run id:
 * eve allocates `wrun_…` session ids the caller cannot choose, so the bridge's
 * ctx.session.id is the session_ref. Same null for missing and foreign rows as
 * above — the difference is not the caller's to learn.
 */
export async function getRunBySessionRef(
  sessionRef: string,
  workspaceId: string,
): Promise<{ id: string } | null> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.sessionRef, sessionRef), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return run ?? null;
}

/** The workspace's recent runs, newest first. Feeds the Alfred page. */
export async function listRecentRuns(workspaceId: string, limit = 10) {
  return db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      objective: agentRuns.objective,
      model: agentRuns.model,
      summary: agentRuns.summary,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(eq(agentRuns.workspaceId, workspaceId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
