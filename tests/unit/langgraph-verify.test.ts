import { expect, it, vi } from "vitest";
import { loadTraceDataset, toEvents, toHeader, toTools, type TraceFetchers } from "../../evals-langgraph/src/verify/db";
import { createLangfuseObservationSource, langfuseCheck, type ObservationsApi, type ObservationRow } from "../../evals-langgraph/src/verify/langfuse";
import { reportJson, renderConsoleTable } from "../../evals-langgraph/src/verify/report";
import { createStdoutBuffer, sliceWindow } from "../../evals-langgraph/src/verify/stdout";
import { createVerifyRun } from "../../evals-langgraph/src/verify/verify";
import type { RunState } from "../../evals-langgraph/src/graph/state";
import { ConfigurationError } from "../../evals-langgraph/src/env-gate";
import type { TraceDataset } from "../../evals-langgraph/src/verify/reconcile";

const t0 = "2026-10-29T00:00:00.000Z";
const t1 = "2026-10-29T00:00:01.000Z";
const generation = (overrides: Partial<ObservationRow> = {}): ObservationRow => ({ id: "g1", traceId: "trace", startTime: "2026-10-29T00:00:00.500Z", type: "GENERATION", model: "m", sessionId: "wrun_session", ...overrides });
function dataset(): TraceDataset {
  return {
    headers: [{ id: "run", workspaceId: "workspace", objective: "Hello", state: "succeeded", model: "m", startedAt: t0, endedAt: t1, lastEventSeq: 3, sessionRef: "wrun_session", error: null }],
    events: [{ sequence: 1, type: "message", data: { role: "user", content: "Hello" } }, { sequence: 2, type: "usage", data: { costUsd: "0.1" } }, { sequence: 3, type: "run.succeeded", data: {} }],
    tools: [], settledUsd: "0.1", critiqueRequested: true,
  };
}
it("maps postgres rows to dataset rows, tolerating null data and timestamps", () => {
  expect(toHeader({ id: "run", workspace_id: "w", objective: "o", state: "succeeded", model: "m", error: null, last_event_seq: 7, session_ref: "wrun_x", started_at: new Date(t0), ended_at: null })).toEqual({ id: "run", workspaceId: "w", objective: "o", state: "succeeded", model: "m", error: null, lastEventSeq: 7, sessionRef: "wrun_x", startedAt: t0, endedAt: null });
  expect(toEvents([{ sequence: 1, type: "usage", data: null }])).toEqual([{ sequence: 1, type: "usage", data: {} }]);
  expect(toTools([{ ok: null, duration_ms: null, error_code: null, arguments: { a: 1 }, result: null }])).toEqual([{ ok: null, durationMs: null, errorCode: null, arguments: { a: 1 }, result: null }]);
});
it("loads the dataset scoped to the header row's own workspace", async () => {
  const calls: string[] = [];
  const fetchers: TraceFetchers = {
    header: async () => toHeader({ id: "run", workspace_id: "w1", objective: "o", state: "succeeded", model: "m", error: null, last_event_seq: 1, session_ref: "wrun_x", started_at: new Date(t0), ended_at: new Date(t1) }),
    events: async (runId, workspaceId) => { calls.push(`events:${runId}:${workspaceId}`); return []; },
    tools: async (runId, workspaceId) => { calls.push(`tools:${runId}:${workspaceId}`); return []; },
    settledUsd: async (runId, workspaceId) => { calls.push(`usd:${runId}:${workspaceId}`); return "0.1"; },
    critiqueRequested: async (runId, workspaceId) => { calls.push(`critique:${runId}:${workspaceId}`); return true; },
  };
  const data = await loadTraceDataset(fetchers, "run");
  expect(data.headers[0].workspaceId).toBe("w1");
  expect(data.settledUsd).toBe("0.1");
  expect(calls).toEqual([`events:run:w1`, `tools:run:w1`, `usd:run:w1`, `critique:run:w1`]);
});
it("returns an empty dataset when the run row is missing", async () => {
  const fetchers: TraceFetchers = { header: async () => undefined, events: async () => { throw new Error("must not query"); }, tools: async () => [], settledUsd: async () => null, critiqueRequested: async () => false };
  expect(await loadTraceDataset(fetchers, "missing")).toEqual({ headers: [], events: [], tools: [], settledUsd: null, critiqueRequested: false });
});
it("correlates Langfuse evidence: session_ref, window, model and usage count", () => {
  expect(langfuseCheck({ sessionRef: "wrun_session", model: "m", startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation()] }).passed).toBe(true);
  expect(langfuseCheck({ sessionRef: null, model: "m", startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation()] }).detail).toMatch(/session_ref/);
  expect(langfuseCheck({ sessionRef: "wrun_session", model: null, startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation()] }).detail).toMatch(/model is null/);
  expect(langfuseCheck({ sessionRef: "wrun_session", model: "m", startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation({ sessionId: "other" })] }).detail).toMatch(/no Langfuse observation/);
  expect(langfuseCheck({ sessionRef: "wrun_session", model: "m", startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation({ startTime: "2026-10-29T00:00:02.000Z" })] }).detail).toMatch(/outside/);
  expect(langfuseCheck({ sessionRef: "wrun_session", model: "m", startedAt: t0, endedAt: t1, usageEventCount: 1, observations: [generation({ model: "other-model" })] }).detail).toMatch(/mismatch/);
  expect(langfuseCheck({ sessionRef: "wrun_session", model: "m", startedAt: t0, endedAt: t1, usageEventCount: 2, observations: [generation()] }).detail).toMatch(/count 1 ≠ usage-event count 2/);
});
it("paginates observations-v2 by cursor and refuses to run without local keys", async () => {
  const pages: { data: ObservationRow[]; meta: { cursor?: string } }[] = [
    { data: [generation({ id: "a" })], meta: { cursor: "next" } },
    { data: [generation({ id: "b" })], meta: {} },
  ];
  const requests: Record<string, unknown>[] = [];
  const client: ObservationsApi = { api: { observations: { getMany: vi.fn(async (request) => { requests.push(request ?? {}); return pages[requests.length - 1]; }) } } };
  const source = createLangfuseObservationSource({ LANGFUSE_PUBLIC_KEY: "pk", LANGFUSE_SECRET_KEY: "sk" }, client);
  const rows = await source({ sessionId: "wrun_session", fromStartTime: t0, toStartTime: t1 });
  expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
  expect(requests[0]).toMatchObject({ sessionId: "wrun_session", fields: "core,basic,model,usage,trace_context" });
  expect(requests[1]).toMatchObject({ cursor: "next" });
  expect(() => createLangfuseObservationSource({})).toThrow(ConfigurationError);
});
it("drives the six-group verification end to end and honors the workspace override", async () => {
  const fetchObservations = vi.fn(async () => [generation()]);
  const verify = createVerifyRun({ loadDataset: async () => dataset(), fetchObservations });
  const result = await verify({ runId: "run", objective: "Hello", startedAt: t0, endedAt: t1 });
  expect(result.status).toBe("passed");
  expect(fetchObservations).toHaveBeenCalledWith({ sessionId: "wrun_session", fromStartTime: t0, toStartTime: t1 });
  const foreign = await createVerifyRun({ loadDataset: async () => dataset(), fetchObservations, workspaceId: "other" })({ runId: "run", objective: "Hello", startedAt: t0, endedAt: t1 });
  expect(foreign.status).toBe("failed");
  if (!("checks" in foreign)) throw new Error("expected live reconciliation checks on the foreign-workspace run");
  expect(foreign.checks.find((check) => check.group === "header")?.detail).toMatch(/workspace/);
});
it("renders an aligned console table and a JSON report with run id and stdout tail", () => {
  const state: RunState = {
    caseId: "chat-grounding/groundedAnswer", skipReconcile: false, startedAt: t0, endedAt: t1,
    item: { id: "chat-grounding/groundedAnswer", suite: "chat-grounding", fixtureOnly: false, objective: "Hello", estimateUsd: "0.50", profileName: "polymath" },
    verdict: "passed",
    execution: { kind: "live", runId: "00000000-0000-4000-8000-000000000001", state: "succeeded", observation: { reply: "r", toolCalls: [], fixture: {} }, diagnostics: [] },
    reconciliation: { status: "failed", checks: [{ group: "langfuse", passed: false, detail: "no Langfuse observation carries sessionId wrun_session" }] },
    assertions: [], observationError: "Stdout capture failed: offline", stdout: "line1\nline2",
  };
  const table = renderConsoleTable([state]);
  expect(table).toMatch(/chat-grounding\/groundedAnswer\s*\| passed\s*\| failed/);
  expect(table).toContain("langfuse: no Langfuse observation carries sessionId wrun_session");
  const json = reportJson([state]);
  expect(json.cases[0].runId).toBe("00000000-0000-4000-8000-000000000001");
  expect(json.cases[0].stdout?.lines).toBe(2);
});
it("slices stdout windows inclusively and drops lines beyond the buffer limit", async () => {
  const entries = [{ at: t0, line: "first" }, { at: "2026-10-29T00:00:00.500Z", line: "middle" }, { at: t1, line: "last" }, { at: "2026-10-29T00:00:02.000Z", line: "after" }];
  expect(sliceWindow(entries, t0, t1)).toBe("first\nmiddle\nlast");
  const buffer = createStdoutBuffer(2);
  buffer.record(t0, "dropped");
  buffer.record(t0, "kept-1");
  buffer.record(t1, "kept-2");
  expect(await buffer.capture(t0, t1)).toBe("kept-1\nkept-2");
});
