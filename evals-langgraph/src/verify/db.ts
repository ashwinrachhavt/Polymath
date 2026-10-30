import postgres from "postgres";
import type { TraceDataset, TraceHeader } from "./reconcile";

/*
 * Read-only workspace-scoped queries over the app's live trace tables
 * (findings §3.4): agent_runs, run_events, tool_calls, spending_reservations
 * and outbox_events. The schema-ready-but-unwired runtime tables
 * (runtime_executions, runtime_signals, tool_invocations) are never asserted
 * on — they have no production callers yet.
 *
 * The fetcher seam exists so the row→dataset mapping is unit-testable without
 * a database; postgresFetchers is the only piece that touches Postgres.
 */
export type TraceFetchers = {
  header: (runId: string) => Promise<TraceHeader | undefined>;
  events: (runId: string, workspaceId: string) => Promise<TraceDataset["events"]>;
  tools: (runId: string, workspaceId: string) => Promise<TraceDataset["tools"]>;
  settledUsd: (runId: string, workspaceId: string) => Promise<string | null>;
  critiqueRequested: (runId: string, workspaceId: string) => Promise<boolean>;
};
type HeaderSqlRow = { id: string; workspace_id: string; objective: string; state: string; model: string | null; error: string | null; last_event_seq: number; session_ref: string | null; started_at: Date | null; ended_at: Date | null };
type EventSqlRow = { sequence: number; type: string; data: Record<string, unknown> | null };
type ToolSqlRow = { ok: boolean | null; duration_ms: number | null; error_code: string | null; arguments: unknown; result: unknown };

export function toHeader(row: HeaderSqlRow): TraceHeader {
  return { id: row.id, workspaceId: row.workspace_id, objective: row.objective, state: row.state, model: row.model, error: row.error, lastEventSeq: row.last_event_seq, sessionRef: row.session_ref, startedAt: row.started_at?.toISOString() ?? null, endedAt: row.ended_at?.toISOString() ?? null };
}
export function toEvents(rows: EventSqlRow[]): TraceDataset["events"] {
  return rows.map((row) => ({ sequence: row.sequence, type: row.type, data: row.data ?? {} }));
}
export function toTools(rows: ToolSqlRow[]): TraceDataset["tools"] {
  return rows.map((row) => ({ ok: row.ok, durationMs: row.duration_ms, errorCode: row.error_code, arguments: row.arguments, result: row.result }));
}
/** Assembles the dataset the reconciliation checks read. A missing run is an empty dataset: the header check fails loudly. */
export async function loadTraceDataset(fetchers: TraceFetchers, runId: string): Promise<TraceDataset> {
  const header = await fetchers.header(runId);
  if (!header) return { headers: [], events: [], tools: [], settledUsd: null, critiqueRequested: false };
  // Every downstream query carries the row's own workspace id: the composite
  // (run_id, workspace_id) scope is what makes the read tenant-safe even
  // though run ids are globally unique UUIDs.
  const [events, tools, settledUsd, critiqueRequested] = await Promise.all([
    fetchers.events(runId, header.workspaceId),
    fetchers.tools(runId, header.workspaceId),
    fetchers.settledUsd(runId, header.workspaceId),
    fetchers.critiqueRequested(runId, header.workspaceId),
  ]);
  return { headers: [header], events, tools, settledUsd, critiqueRequested };
}
/** Production fetchers. SELECT-only; the caller owns the connection lifecycle via close(). */
export function postgresFetchers(connectionString: string): TraceFetchers & { close: () => Promise<void> } {
  const sql = postgres(connectionString, { max: 1, prepare: false });
  return {
    header: async (runId) => toHeader((await sql<HeaderSqlRow[]>`
      select id, workspace_id, objective, state, model, error, last_event_seq, session_ref, started_at, ended_at
      from agent_runs where id = ${runId} limit 1`)[0]),
    events: async (runId, workspaceId) => toEvents(await sql<EventSqlRow[]>`
      select sequence, type, data from run_events
      where run_id = ${runId} and workspace_id = ${workspaceId} order by sequence`),
    tools: async (runId, workspaceId) => toTools(await sql<ToolSqlRow[]>`
      select ok, duration_ms, error_code, arguments, result from tool_calls
      where run_id = ${runId} and workspace_id = ${workspaceId} order by created_at`),
    settledUsd: async (runId, workspaceId) =>
      (await sql<{ settled_usd: string }[]>`
        select settled_usd from spending_reservations
        where run_id = ${runId} and workspace_id = ${workspaceId} and settled_usd is not null
        order by settled_at desc limit 1`)[0]?.settled_usd ?? null,
    critiqueRequested: async (runId, workspaceId) =>
      (await sql<{ one: number }[]>`
        select 1 as one from outbox_events
        where topic = 'run.critique_requested' and dispatch_key = ${runId} and workspace_id = ${workspaceId}
        limit 1`).length > 0,
    close: () => sql.end({ timeout: 1 }),
  };
}
