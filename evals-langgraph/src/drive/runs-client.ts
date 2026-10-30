import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { EvalCase, Observation } from "../cases/types";
import type { HarnessConfig } from "../config";
import { ConfigurationError } from "../env-gate";
import { readRunStream, type TerminalState } from "./stream";
export class RunApiError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`Run API ${status}: ${code}`); }
}
export type LiveRun = { runId: string; state: TerminalState; observation: Observation; diagnostics: string[] };
export type ClientDependencies = { fetch: typeof fetch; uuid: () => string; sleep: (ms: number) => Promise<void> };
const runSchema = z.object({ run: z.object({ id: z.string().uuid(), state: z.enum(["queued", "running", "waiting_input", "waiting_approval", "succeeded", "failed", "cancelled"]), summary: z.string().nullable().optional() }) });
export function createRunsClient(config: HarnessConfig, dependencies: Partial<ClientDependencies> = {}) {
  const io: ClientDependencies = { fetch: globalThis.fetch, uuid: randomUUID, sleep: async (ms) => { await delay(ms); }, ...dependencies };
  async function request(path: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (config.auth.kind === "companion") headers.set("Authorization", `Bearer ${config.auth.token}`);
    return io.fetch(`${config.baseUrl}${path}`, { ...init, headers, signal, redirect: "error" });
  }
  async function apiError(response: Response): Promise<Error> {
    const value: unknown = await response.json();
    const problem = z.object({ code: z.string().optional(), type: z.string().optional() }).parse(value);
    const code = problem.code ?? problem.type ?? "unknown_error";
    return response.status === 503 && code.includes("agent_bridge_unavailable")
      ? new ConfigurationError("agent_bridge_unavailable: configure EVE_BRIDGE_SECRET in next dev and eve") : new RunApiError(response.status, code);
  }
  async function start(item: EvalCase): Promise<string> {
    const signal = AbortSignal.timeout(config.timeoutMs);
    let key = io.uuid();
    for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
      const response = await request("/api/v1/runs", signal, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ objective: item.objective, estimateUsd: item.estimateUsd, profileName: item.profileName }) });
      if (response.status === 201) return z.object({ runId: z.string().uuid() }).parse(await response.json()).runId;
      const error = await apiError(response);
      if (response.status !== 409 && response.status !== 502) throw error;
      if (attempt + 1 === config.maxAttempts) throw error;
      // A 502 frees the receipt. A 409 still owns it: retry the SAME UUID.
      if (response.status === 502) key = io.uuid();
      await io.sleep(config.pollMs);
    }
    throw new ConfigurationError("maxAttempts must be positive");
  }
  async function follow(runId: string): Promise<LiveRun> {
    const signal = AbortSignal.timeout(config.timeoutMs);
    let observation: Observation = { reply: "", toolCalls: [], fixture: {} };
    const diagnostics: string[] = [];
    try {
      const response = await request(`/api/v1/runs/${runId}/stream`, signal, { headers: { Accept: "application/x-ndjson, text/event-stream" } });
      if (!response.ok) throw await apiError(response);
      const streamed = await readRunStream(response, runId);
      observation = streamed.observation;
      diagnostics.push(...streamed.diagnostics);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      diagnostics.push(`Stream unavailable; using polling: ${String(error)}`);
    }
    while (!signal.aborted) {
      const response = await request(`/api/v1/runs/${runId}`, signal);
      if (!response.ok) throw await apiError(response);
      const { run } = runSchema.parse(await response.json());
      if (run.id !== runId) throw new Error("Polling runId mismatch");
      if (["succeeded", "failed", "cancelled"].includes(run.state)) {
        const state = z.enum(["succeeded", "failed", "cancelled"]).parse(run.state);
        return { runId, state, observation: { ...observation, reply: observation.reply || run.summary || "" }, diagnostics };
      }
      await io.sleep(config.pollMs);
    }
    throw new Error(`Timed out waiting for run ${runId}`);
  }
  return { start, follow };
}
export type RunsClient = ReturnType<typeof createRunsClient>;
