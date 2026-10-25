import { and, count, desc, eq, gte, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { agentProfiles, agentRuns, runEvents, toolCalls } from "./schema";

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

export type RunUsage = {
  /*
   * Summed over the run's cost-bearing usage events as numeric in SQL; text
   * keeps the precision. Null when no usage event carries a cost: unpriced
   * usage means the cost is unknown, never zero.
   */
  usd: string | null;
  /** Usage events carrying a costUsd figure. */
  pricedEvents: number;
  /** All usage events, priced or not. */
  usageEvents: number;
  inputTokens: number;
  outputTokens: number;
};

/*
 * The recorded usage of one run, summed from its usage events in SQL - the
 * same derivation the terminal close settles with. Null when the run has no
 * usage events at all. The recording contract does not guarantee
 * completeness: a step may report no usage, or usage without a price, and a
 * failed bridge write is dropped - so these are recorded figures, never a
 * guaranteed complete bill.
 */
export async function getRunUsage(workspaceId: string, runId: string): Promise<RunUsage | null> {
  const rows = await db.execute(sql`
    select
      sum((${runEvents.data}->>'costUsd')::numeric)::text as usd,
      count((${runEvents.data}->>'costUsd'))::int as priced_events,
      count(*)::int as usage_events,
      coalesce(sum((${runEvents.data}->>'inputTokens')::bigint), 0)::int as input_tokens,
      coalesce(sum((${runEvents.data}->>'outputTokens')::bigint), 0)::int as output_tokens
    from run_events
    where run_id = ${runId} and workspace_id = ${workspaceId} and type = 'usage'
  `);
  const row = rows[0] as
    | { usd: string | null; priced_events: number; usage_events: number; input_tokens: number; output_tokens: number }
    | undefined;
  if (!row || row.usage_events === 0) return null;
  return {
    usd: row.usd,
    pricedEvents: row.priced_events,
    usageEvents: row.usage_events,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

export type UsageLedgerRow = {
  runId: string;
  objective: string;
  state: string;
  startedAt: Date | null;
  /** Summed recorded cost; null when no usage event carried a price. */
  usd: string | null;
  pricedEvents: number;
  usageEvents: number;
  inputTokens: number;
  outputTokens: number;
};

export type UsageLedger = {
  rows: UsageLedgerRow[];
  /** Runs with usage events but no recorded price: real work, unknown cost. */
  unpricedRuns: number;
  /** Total over the window; null when nothing was priced. */
  totalUsd: string | null;
};

/**
 * The workspace spending ledger: one row per run with recorded usage in the
 * window, newest first. Same derivation and same honesty contract as
 * getRunUsage - recorded figures, never a guaranteed complete bill; unpriced
 * work is named, not silently zeroed.
 */
export async function getUsageLedger(workspaceId: string, days: number, limit = 50): Promise<UsageLedger> {
  const rows = await db.execute(sql`
    select
      r.id as run_id,
      r.objective as objective,
      r.state::text as state,
      r.started_at as started_at,
      sum((e.data->>'costUsd')::numeric)::text as usd,
      count(e.data->>'costUsd')::int as priced_events,
      count(e.id)::int as usage_events,
      coalesce(sum((e.data->>'inputTokens')::bigint), 0)::int as input_tokens,
      coalesce(sum((e.data->>'outputTokens')::bigint), 0)::int as output_tokens
    from agent_runs r
    join run_events e
      on e.run_id = r.id and e.workspace_id = r.workspace_id and e.type = 'usage'
    where r.workspace_id = ${workspaceId}
      and r.created_at >= now() - make_interval(days => ${days})
    group by r.id, r.objective, r.state, r.started_at
    order by max(e.created_at) desc
    limit ${limit}
  `);
  // db.execute returns timestamptz as text; startedAt is coerced below.
  const ledger = rows as unknown as {
    run_id: string; objective: string; state: string; started_at: string | null;
    usd: string | null; priced_events: number; usage_events: number; input_tokens: number; output_tokens: number;
  }[];
  let totalUsd: string | null = null;
  let unpricedRuns = 0;
  let total = 0;
  for (const row of ledger) {
    if (row.usd === null) unpricedRuns += 1;
    else total += Number(row.usd);
  }
  if (ledger.some((row) => row.usd !== null)) totalUsd = total.toFixed(4).replace(/0+$/, "").replace(/\.$/, ".0");
  return {
    rows: ledger.map((row) => ({
      runId: row.run_id,
      objective: row.objective,
      state: row.state,
      startedAt: row.started_at ? new Date(row.started_at) : null,
      usd: row.usd,
      pricedEvents: row.priced_events,
      usageEvents: row.usage_events,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    })),
    unpricedRuns,
    totalUsd,
  };
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
      subjects: agentRuns.subjects,
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
/** The workspace's one first-party profile (agents/product.md), with its brief. */
export async function getDefaultProfile(auth: AuthContext) {
  const [profile] = await db
    .select({
      id: agentProfiles.id,
      name: agentProfiles.name,
      description: agentProfiles.description,
      instructions: agentProfiles.instructions,
      version: agentProfiles.version,
    })
    .from(agentProfiles)
    .where(and(eq(agentProfiles.workspaceId, auth.workspaceId), eq(agentProfiles.isDefault, true)))
    .limit(1);
  return profile ?? null;
}

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
/** The run's project subject, or null when the run is not project-scoped. */
export function projectSubjectOf(subjects: unknown): { id: string } | null {
  if (!Array.isArray(subjects)) return null;
  for (const subject of subjects as Array<{ type?: string; id?: string }>) {
    if (subject?.type === "project" && typeof subject.id === "string") return { id: subject.id };
  }
  return null;
}

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
