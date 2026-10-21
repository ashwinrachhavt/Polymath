import { and, asc, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { agentProfiles, agentRuns, runEvents, toolCalls } from "./schema";

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

/**
 * The columns the gateway binds a call against. Read fresh on every call and
 * never cached: a cancelled run or a reassigned owner must take effect on the
 * next request, not when a token expires.
 */
export async function getRunForGateway(runId: string, workspaceId: string) {
  const [run] = await db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      createdBy: agentRuns.createdBy,
      sessionRef: agentRuns.sessionRef,
      policySnapshot: agentRuns.policySnapshot,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return run ?? null;
}

/**
 * The profile name that decides which Eve agent serves a run. The routing table
 * lives in `eveAgentForProfile`, so the stream proxy needs the name, not the id,
 * to pick the same mount the driver started the session on. A run whose profile
 * row has gone returns null; callers fall back to the default agent.
 */
export async function getProfileNameForRun(workspaceId: string, runId: string) {
  const [row] = await db
    .select({ name: agentProfiles.name })
    .from(agentRuns)
    .leftJoin(agentProfiles, eq(agentRuns.agentProfileId, agentProfiles.id))
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.workspaceId, workspaceId)))
    .limit(1);
  return row?.name ?? null;
}

/**
 * One run's timeline, oldest first: every event the bridge persisted, which is
 * what the SSE cursor replays from. Workspace-scoped like every other read, and
 * the caller has already proved the run belongs here through getRun.
 */
export async function listRunEvents(workspaceId: string, runId: string) {
  return db
    .select({ sequence: runEvents.sequence, type: runEvents.type, data: runEvents.data, createdAt: runEvents.createdAt })
    .from(runEvents)
    .where(and(eq(runEvents.workspaceId, workspaceId), eq(runEvents.runId, runId)))
    .orderBy(asc(runEvents.sequence));
}

/**
 * One run's tool calls, oldest first, for the conversation page's Details
 * disclosure. Rows are already redacted at the write points (the bridge's
 * `recordToolCall` and the gateway's settlement), so this read needs no second
 * pass — arguments and results are safe to show the owner.
 */
export async function listRunToolCalls(workspaceId: string, runId: string) {
  return db
    .select({
      id: toolCalls.id,
      toolName: toolCalls.toolName,
      accountAlias: toolCalls.accountAlias,
      arguments: toolCalls.arguments,
      result: toolCalls.result,
      ok: toolCalls.ok,
      errorCode: toolCalls.errorCode,
      durationMs: toolCalls.durationMs,
      createdAt: toolCalls.createdAt,
    })
    .from(toolCalls)
    .where(and(eq(toolCalls.workspaceId, workspaceId), eq(toolCalls.runId, runId)))
    .orderBy(asc(toolCalls.createdAt));
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

/** One profile by name, workspace-scoped; foreign and missing names return the same null. */
export async function getProfileByName(workspaceId: string, name: string) {
  const [profile] = await db
    .select({ id: agentProfiles.id, name: agentProfiles.name, description: agentProfiles.description })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.name, name)))
    .limit(1);
  return profile ?? null;
}

/** The profile's frozen-at-start model selection, for the Assistant's picker. */
export async function getProfileModelPolicy(workspaceId: string, name: string) {
  const [row] = await db
    .select({ modelPolicy: agentProfiles.modelPolicy })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, workspaceId), eq(agentProfiles.name, name)))
    .limit(1);
  return row?.modelPolicy ?? null;
}

export const RUN_STATES = [
  "queued",
  "running",
  "waiting_input",
  "waiting_approval",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type RunStateFilter = (typeof RUN_STATES)[number];

export type RunPageInput = { query?: string; state?: RunStateFilter; limit: number; offset: number };

function runWhere(workspaceId: string, input: Pick<RunPageInput, "query" | "state">): SQL {
  const parts: SQL[] = [eq(agentRuns.workspaceId, workspaceId)];
  if (input.state) parts.push(eq(agentRuns.state, input.state));
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    parts.push(or(ilike(agentRuns.objective, like), ilike(agentRuns.summary, like))!);
  }
  return and(...parts)!;
}

/** One page of runs, newest first, with the filtered total for the pager. */
export async function pageRuns(workspaceId: string, input: RunPageInput) {
  const where = runWhere(workspaceId, input);
  const [items, [totalRow]] = await Promise.all([
    db
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
      .where(where)
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(input.limit)
      .offset(input.offset),
    db.select({ total: count() }).from(agentRuns).where(where),
  ]);
  return { items, total: totalRow?.total ?? 0 };
}

/**
 * Runs pinned to one skill, newest first, for the skill detail page. The pin
 * lives inside the frozen policy snapshot (`skill.id`), so this reads jsonb
 * rather than joining the skills table: the row may be gone and the history
 * still has to read. Scoped by workspace as well, so a skill id from another
 * tenant returns nothing.
 */
export async function listRunsForSkill(workspaceId: string, skillId: string, limit = 10) {
  return db
    .select({
      id: agentRuns.id,
      state: agentRuns.state,
      objective: agentRuns.objective,
      summary: agentRuns.summary,
      error: agentRuns.error,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.workspaceId, workspaceId),
        sql`${agentRuns.policySnapshot}->'skill'->>'id' = ${skillId}`,
      ),
    )
    .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
    .limit(limit);
}

/*
 * The Briefing's "Agents overnight" log: recent runs with their profile name
 * plus the totals the panel header reports ("N runs · nothing failed"). Runs
 * stay inside the workspace; the window is the caller's (the Briefing passes
 * the last 24 hours).
 */
export async function overnightRuns(workspaceId: string, since: Date, limit = 12) {
  const where = and(eq(agentRuns.workspaceId, workspaceId), gte(agentRuns.createdAt, since));
  const [items, totals] = await Promise.all([
    db
      .select({
        id: agentRuns.id,
        state: agentRuns.state,
        objective: agentRuns.objective,
        summary: agentRuns.summary,
        error: agentRuns.error,
        createdAt: agentRuns.createdAt,
        endedAt: agentRuns.endedAt,
        profileName: agentProfiles.name,
      })
      .from(agentRuns)
      .leftJoin(agentProfiles, eq(agentRuns.agentProfileId, agentProfiles.id))
      .where(where)
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id))
      .limit(limit),
    db
      .select({
        total: count(),
        failed: count(sql`case when ${agentRuns.state} = 'failed' then 1 end`),
      })
      .from(agentRuns)
      .where(where),
  ]);
  return { items, total: totals[0]?.total ?? 0, failed: totals[0]?.failed ?? 0 };
}

/** Who proposed it: run objectives and profile names for a page of proposals. */
export async function listRunAttributions(workspaceId: string, runIds: string[]) {
  if (runIds.length === 0) return new Map<string, { objective: string; profileName: string | null }>();
  const rows = await db
    .select({ id: agentRuns.id, objective: agentRuns.objective, profileName: agentProfiles.name })
    .from(agentRuns)
    .leftJoin(agentProfiles, eq(agentRuns.agentProfileId, agentProfiles.id))
    .where(and(eq(agentRuns.workspaceId, workspaceId), inArray(agentRuns.id, runIds)));
  return new Map(rows.map((row) => [row.id, { objective: row.objective, profileName: row.profileName }]));
}
