import { Annotation } from "@langchain/langgraph";
import type { EvalCase, Observation } from "../cases/types";
import type { AssertionResult } from "../scoring/matchers";
import type { Verdict } from "../scoring/verdict";
import type { Reconciliation } from "../verify/reconcile";
export type Execution =
  | { kind: "fixture"; observation: Observation }
  | { kind: "live"; runId: string; observation: Observation; state: "succeeded" | "failed" | "cancelled"; diagnostics: string[] }
  | { kind: "error"; message: string; configError: boolean; runId?: string };
export const EvalRunState = Annotation.Root({
  caseId: Annotation<string>(),
  skipReconcile: Annotation<boolean>(),
  item: Annotation<Omit<EvalCase, "assertions">>(),
  startedAt: Annotation<string>(),
  endedAt: Annotation<string>(),
  execution: Annotation<Execution>(),
  stdout: Annotation<string | null>(),
  observationError: Annotation<string>(),
  assertions: Annotation<AssertionResult[]>(),
  verdict: Annotation<Verdict>(),
  reconciliation: Annotation<Reconciliation>(),
});
export type RunState = typeof EvalRunState.State;
