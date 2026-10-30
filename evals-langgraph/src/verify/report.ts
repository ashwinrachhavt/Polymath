import type { RunState } from "../graph/state";

/*
 * Per-run report in the repo's eval-report pattern: an aligned console table
 * for the terminal and a JSON document for evidence retention. The JSON keeps
 * the app run id, the reconciliation checks and a bounded stdout tail — the
 * crash diagnostics leg (findings §4); Postgres stays the authoritative record.
 */
const STDOUT_TAIL_LINES = 200;
function describe(result: RunState): string {
  const reconciliation = result.reconciliation;
  // "in" narrowing, not status equality: this compiler does not eliminate the
  // "failed" arm after an early return on the status discriminant.
  if ("checks" in reconciliation) {
    if (reconciliation.status === "failed") return reconciliation.checks.filter((check) => !check.passed).map((check) => `${check.group}: ${check.detail}`).join("; ");
    return result.observationError ? `stdout: ${result.observationError}` : result.execution.kind === "error" ? result.execution.message : "";
  }
  return reconciliation.reason;
}
export function renderConsoleTable(results: RunState[]): string {
  const head = ["case", "verdict", "reconcile", "detail"];
  const rows = results.map((result) => [result.caseId, result.verdict, result.reconciliation.status, describe(result)]);
  const width = head.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column].length)));
  const line = (cells: string[]): string => cells.map((cell, column) => cell.padEnd(width[column])).join(" | ");
  return [line(head), width.map((size) => "-".repeat(size)).join("-+-"), ...rows.map(line)].join("\n");
}
export function reportJson(results: RunState[]) {
  return {
    cases: results.map((result) => ({
      caseId: result.caseId,
      verdict: result.verdict,
      execution: result.execution.kind,
      runId: result.execution.kind === "live" ? result.execution.runId : undefined,
      diagnostics: result.execution.kind === "live" ? result.execution.diagnostics : undefined,
      observationError: result.observationError || undefined,
      reconciliation: result.reconciliation,
      assertions: result.assertions,
      stdout: result.stdout === null ? null : { lines: result.stdout.split("\n").length, tail: result.stdout.split("\n").slice(-STDOUT_TAIL_LINES).join("\n") },
    })),
  };
}
