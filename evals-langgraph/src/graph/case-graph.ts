import { END, START, StateGraph } from "@langchain/langgraph";
import { caseRegistry } from "../cases/registry";
import { readConfig } from "../config";
import { driveFixture } from "../drive/fixtures";
import { createRunsClient, type RunsClient } from "../drive/runs-client";
import { assertEvalEnvironment, ConfigurationError } from "../env-gate";
import { scoreAssertions } from "../scoring/matchers";
import { verdict } from "../scoring/verdict";
import type { Reconciliation, VerifyRun } from "../verify/reconcile";
import { EvalRunState, type RunState } from "./state";
export type GraphDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  client?: RunsClient;
  verify?: VerifyRun;
  captureStdout?: (start: string, end: string) => Promise<string>;
  now?: () => string;
};
function buildGraph(dependencies: GraphDependencies) {
  const env = dependencies.env ?? process.env;
  const now = dependencies.now ?? (() => new Date().toISOString());
  async function prepare(state: RunState): Promise<Partial<RunState>> {
    assertEvalEnvironment(env);
    const item = caseRegistry(env).find((item) => item.id === state.caseId);
    if (!item) throw new ConfigurationError(`Unknown caseId: ${state.caseId}`);
    if (!item.fixtureOnly && !env.GEMINI_API_KEY) throw new ConfigurationError("Live cases require GEMINI_API_KEY in the local app/eve environment");
    return { item: { id: item.id, suite: item.suite, fixtureOnly: item.fixtureOnly, objective: item.objective, estimateUsd: item.estimateUsd, profileName: item.profileName }, startedAt: now() };
  }
  async function drive(state: RunState): Promise<Partial<RunState>> {
    let runId: string | undefined;
    try {
      const item = caseRegistry(env).find((item) => item.id === state.caseId);
      if (!item) throw new ConfigurationError(`Unknown caseId: ${state.caseId}`);
      if (item.fixtureOnly) return { execution: { kind: "fixture", observation: await driveFixture(item) }, endedAt: now() };
      const client = dependencies.client ?? createRunsClient(readConfig(env));
      runId = await client.start(item);
      const result = await client.follow(runId);
      return { execution: { kind: "live", ...result }, endedAt: now() };
    } catch (error) {
      return { execution: { kind: "error", message: String(error), configError: error instanceof ConfigurationError, ...(runId ? { runId } : {}) }, endedAt: now() };
    }
  }
  async function observe(state: RunState): Promise<Partial<RunState>> {
    if (state.execution.kind === "fixture") return { stdout: null };
    if (!dependencies.captureStdout) return { stdout: null, observationError: "App stdout capture adapter not configured" };
    try { return { stdout: await dependencies.captureStdout(state.startedAt, state.endedAt) }; }
    catch (error) { return { stdout: null, observationError: `Stdout capture failed: ${String(error)}` }; }
  }
  async function score(state: RunState): Promise<Partial<RunState>> {
    const execution = state.execution;
    if (execution.kind === "error") return { assertions: [], verdict: "failed" };
    const item = caseRegistry(env).find((item) => item.id === state.caseId);
    if (!item) throw new ConfigurationError(`Unknown caseId: ${state.caseId}`);
    const assertions = await scoreAssertions(item.assertions, execution.observation);
    return { assertions, verdict: verdict(assertions, execution.kind === "live" && execution.state !== "succeeded" ? `Run ${execution.state}` : undefined) };
  }
  async function reconcile(state: RunState): Promise<Partial<RunState>> {
    const execution = state.execution;
    if (state.item.fixtureOnly) return { reconciliation: { status: "not_applicable", reason: "Graph-local fixture: no application run, rows or traces exist" } };
    if (state.skipReconcile) return { reconciliation: { status: "skipped", reason: "Explicitly disabled; live verification is not complete" } };
    const runId = execution.kind === "fixture" ? undefined : execution.runId;
    if (!runId || !dependencies.verify) return { reconciliation: { status: "pending", reason: "Live run and Postgres/Langfuse verification adapter required" } };
    try {
      const result = await dependencies.verify({ runId, objective: state.item.objective, startedAt: state.startedAt, endedAt: state.endedAt });
      return { reconciliation: requireStdout(result, state.stdout) };
    } catch (error) {
      // Missing verification credentials/setup block promotion (exit 2, pending)
      // rather than failing the eval (exit 1) — a red eval and missing setup
      // must stay distinguishable.
      if (error instanceof ConfigurationError) return { reconciliation: { status: "pending", reason: `Verification configuration: ${String(error)}` } };
      return { reconciliation: { status: "failed", checks: [{ group: "langfuse", passed: false, detail: `Reconciliation adapter failed: ${String(error)}` }] } };
    }
  }
  return new StateGraph(EvalRunState).addNode("prepare", prepare).addNode("drive", drive).addNode("observe", observe)
    .addNode("score", score).addNode("reconcile", reconcile)
    .addEdge(START, "prepare").addEdge("prepare", "drive").addEdge("drive", "observe")
    .addEdge("observe", "score").addEdge("score", "reconcile").addEdge("reconcile", END).compile();
}
function requireStdout(result: Reconciliation, stdout: string | null): Reconciliation {
  return result.status === "passed" && stdout === null
    ? { status: "pending", reason: "Reconciliation returned checks but app stdout window was not captured" } : result;
}
export function createCaseGraph(dependencies: GraphDependencies = {}): ReturnType<typeof buildGraph> { return buildGraph(dependencies); }
export const graph = createCaseGraph();
