import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentProfiles, agentRuns, toolCalls } from "./schema";

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
): Promise<(Pick<typeof agentRuns.$inferSelect, "id" | "policySnapshot" | "state"> & Partial<Pick<typeof agentRuns.$inferSelect, "subjects">>) | null> {
  const runs = await db
    .select({ id: agentRuns.id, policySnapshot: agentRuns.policySnapshot, state: agentRuns.state, subjects: agentRuns.subjects })
    .from(agentRuns)
    .where(and(eq(agentRuns.sessionRef, sessionRef), eq(agentRuns.workspaceId, workspaceId)))
    .limit(2);
  // Legacy rows lack a unique session_ref constraint. Ambiguity is a denial,
  // never an arbitrary choice of another run's policy or spending reservation.
  return runs.length === 1 ? runs[0] : null;
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

/**
 * One run, for the workspace that owns it. A run in another workspace and a
 * run that does not exist return the same null: the difference is not the
 * caller's to learn.
 */
export async function getRun(workspaceId: string, runId: string) {
  const [run] = await db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      objective: agentRuns.objective,
      model: agentRuns.model,
      summary: agentRuns.summary,
      error: agentRuns.error,
      startedAt: agentRuns.startedAt,
      endedAt: agentRuns.endedAt,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return run ?? null;
}

/** Tool names a documents search is recorded under (the capability and the tool file name). */
const DOCUMENT_SEARCH_TOOLS = ["documents_search", "documents.search"];

/**
 * The raw documents.search results for each run, oldest first. The caller
 * folds them into citations; reading stays inside the workspace.
 */
export async function listDocumentSearchResults(workspaceId: string, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, unknown[]>();
  const rows = await db
    .select({ runId: toolCalls.runId, result: toolCalls.result })
    .from(toolCalls)
    .where(and(
      eq(toolCalls.workspaceId, workspaceId),
      inArray(toolCalls.runId, runIds),
      inArray(toolCalls.toolName, DOCUMENT_SEARCH_TOOLS),
      eq(toolCalls.ok, true),
    ))
    .orderBy(toolCalls.createdAt);
  const byRun = new Map<string, unknown[]>();
  for (const row of rows) byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row.result]);
  return byRun;
}

/** The workspace's specialist bench: every non-default profile, for the specialists page. */
export async function listSpecialistProfiles(workspaceId: string) {
  return db
    .select({
      id: agentProfiles.id,
      name: agentProfiles.name,
      description: agentProfiles.description,
      allowedTools: agentProfiles.allowedTools,
      createdAt: agentProfiles.createdAt,
    })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.isDefault, false)))
    .orderBy(agentProfiles.name);
}

/** One profile by name, workspace-scoped; foreign and missing names return the same null. */
export async function getProfileByName(workspaceId: string, name: string) {
  const [profile] = await db
    .select({ id: agentProfiles.id, name: agentProfiles.name, description: agentProfiles.description })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.name, name)))
    .limit(1);
  return profile ?? null;
}

/**
 * Recent runs with their profile's display name, for the specialists page's
 * "who did what" list. Runs whose profile row is gone keep no name — the join
 * is a left join so a deleted profile cannot erase the run's record.
 */
export async function listRecentRunsWithProfile(workspaceId: string, limit = 10) {
  return db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      objective: agentRuns.objective,
      model: agentRuns.model,
      summary: agentRuns.summary,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
      profileName: agentProfiles.name,
      profileDescription: agentProfiles.description,
    })
    .from(agentRuns)
    .leftJoin(agentProfiles, eq(agentRuns.agentProfileId, agentProfiles.id))
    .where(eq(agentRuns.workspaceId, workspaceId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);
}
