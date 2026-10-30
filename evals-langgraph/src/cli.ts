import { caseRegistry } from "./cases/registry";
import { createCaseGraph } from "./graph/case-graph";
import type { RunState } from "./graph/state";
import { exitCode } from "./scoring/verdict";
export function reportExitCode(results: RunState[], strict: boolean): 0 | 1 | 2 {
  if (results.some((result) => result.execution.kind === "error" && result.execution.configError)) return 2;
  if (results.some((result) => result.reconciliation.status === "pending")) return 2;
  if (results.some((result) => result.reconciliation.status === "failed")) return 1;
  return exitCode(results.map((result) => result.verdict), strict);
}
async function main(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    const cases = caseRegistry(process.env).filter((item) => args.includes("--live") ? !item.fixtureOnly : item.fixtureOnly);
    const results: RunState[] = [];
    // Serial by default, matching eve maxConcurrency=1 and model quota limits.
    for (const item of cases) results.push(await createCaseGraph().invoke({ caseId: item.id, skipReconcile: args.includes("--skip-reconcile") }));
    console.log(JSON.stringify(results, null, 2));
    process.exitCode = reportExitCode(results, args.includes("--strict"));
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
