import { LangfuseClient } from "@langfuse/client";
import { ConfigurationError } from "../env-gate";
import type { VerificationCheck } from "./reconcile";

/*
 * The sixth reconciliation group: Langfuse ↔ Postgres (findings §3.4.6).
 * A trace name alone is not correlation proof — observations must carry the
 * run's session_ref, fall inside the run's window, name the run's frozen
 * model, and count the same as the app's own usage events.
 *
 * Reads go through the observations-v2 API (scoped SDK v5): cursor-paginated
 * rows, never the deprecated legacy trace endpoints.
 */
export type ObservationRow = { id: string; traceId: string | null; startTime: string; type: string; model?: string | null; sessionId?: string | null };
export type ObservationQuery = { sessionId: string; fromStartTime: string; toStartTime: string };
export type ObservationSource = (query: ObservationQuery) => Promise<ObservationRow[]>;
export type LangfuseEvidence = { sessionRef: string | null; model: string | null; startedAt: string; endedAt: string; usageEventCount: number; observations: ObservationRow[] };
const FIELDS = "core,basic,model,usage,trace_context";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;

function fail(detail: string): VerificationCheck {
  return { group: "langfuse", passed: false, detail };
}
export function langfuseCheck(evidence: LangfuseEvidence): VerificationCheck {
  const { sessionRef, model, startedAt, endedAt, usageEventCount, observations } = evidence;
  if (!sessionRef) return fail("agent_runs.session_ref is null; no Langfuse correlation key");
  if (!model) return fail("agent_runs.model is null; no model to match generations against");
  const correlated = observations.filter((row) => row.sessionId === sessionRef);
  if (correlated.length === 0) return fail(`no Langfuse observation carries sessionId ${sessionRef}`);
  const from = Date.parse(startedAt);
  const to = Date.parse(endedAt);
  const outside = correlated.filter((row) => { const at = Date.parse(row.startTime); return at < from || at > to; });
  if (outside.length) return fail(`${outside.length} observation(s) start outside [started_at, ended_at]; first ${outside[0].id} at ${outside[0].startTime}`);
  const generations = correlated.filter((row) => row.type === "GENERATION");
  const mismatched = generations.filter((row) => row.model !== model);
  if (mismatched.length) return fail(`generation model mismatch: ${mismatched[0].model ?? "null"} ≠ run model ${model}`);
  if (generations.length !== usageEventCount) return fail(`generation count ${generations.length} ≠ usage-event count ${usageEventCount}`);
  return { group: "langfuse", passed: true, detail: `${generations.length} generation(s) correlated via session_ref ${sessionRef}, model ${model}, inside the run window` };
}

type ObservationsPage = { data: ObservationRow[]; meta: { cursor?: string } };
export type ObservationsApi = {
  api: { observations: { getMany: (request?: { sessionId?: string; fromStartTime?: string; toStartTime?: string; fields?: string; limit?: number; cursor?: string }) => Promise<ObservationsPage> } };
};
/** Builds the observations source from the local Langfuse credentials; throws before any run is driven when they are missing. */
export function createLangfuseObservationSource(env: Readonly<Record<string, string | undefined>>, client?: ObservationsApi): ObservationSource {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new ConfigurationError("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required for live reconciliation; pass --skip-reconcile to score without it");
  }
  const api = client ?? new LangfuseClient({ publicKey, secretKey, baseUrl: env.LANGFUSE_BASE_URL ?? "http://127.0.0.1:3100" });
  return async (query) => {
    const rows: ObservationRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await api.api.observations.getMany({ ...query, fields: FIELDS, limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) });
      for (const row of response.data) rows.push({ id: row.id, traceId: row.traceId, startTime: row.startTime, type: row.type, model: row.model, sessionId: row.sessionId });
      cursor = response.meta.cursor;
      if (!cursor) return rows;
    }
    throw new Error(`Langfuse observations for session ${query.sessionId} exceeded ${MAX_PAGES * PAGE_LIMIT} rows`);
  };
}
