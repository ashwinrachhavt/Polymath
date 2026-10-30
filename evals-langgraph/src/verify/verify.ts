import type { ObservationSource } from "./langfuse";
import { langfuseCheck } from "./langfuse";
import { reconcileDataset, type TraceDataset, type VerifyRun } from "./reconcile";

/*
 * The graph's `verify` adapter: loads the Postgres-side dataset for the run,
 * fetches the Langfuse observations correlated to the run's session_ref, and
 * returns the full six-group reconciliation. Configuration errors (missing
 * credentials) propagate to the graph, which downgrades them to `pending` so
 * missing setup blocks promotion (exit 2) instead of failing the eval (exit 1).
 */
export type VerifyDependencies = {
  loadDataset: (runId: string) => Promise<TraceDataset>;
  fetchObservations: ObservationSource;
  /** Independently known workspace id; when set, a run row from another workspace fails the header check. */
  workspaceId?: string;
};
export function createVerifyRun(dependencies: VerifyDependencies): VerifyRun {
  return async (scope) => {
    const data = await dependencies.loadDataset(scope.runId);
    const header = data.headers[0];
    // Prefer the app's own recorded window; the harness window is the fallback.
    const startedAt = header?.startedAt ?? scope.startedAt;
    const endedAt = header?.endedAt ?? scope.endedAt;
    const observations = header?.sessionRef
      ? await dependencies.fetchObservations({ sessionId: header.sessionRef, fromStartTime: startedAt, toStartTime: endedAt })
      : [];
    const check = langfuseCheck({
      sessionRef: header?.sessionRef ?? null,
      model: header?.model ?? null,
      startedAt,
      endedAt,
      usageEventCount: data.events.filter((event) => event.type === "usage").length,
      observations,
    });
    return reconcileDataset({ runId: scope.runId, workspaceId: dependencies.workspaceId ?? header?.workspaceId ?? "", objective: scope.objective }, data, check);
  };
}
