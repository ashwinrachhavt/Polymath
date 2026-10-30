import { caseRegistry } from "./cases/registry";
import { ConfigurationError } from "./env-gate";
import { createCaseGraph } from "./graph/case-graph";
import type { RunState } from "./graph/state";
import { exitCode } from "./scoring/verdict";
import { loadTraceDataset, postgresFetchers } from "./verify/db";
import { createLangfuseObservationSource } from "./verify/langfuse";
import { reportJson, renderConsoleTable } from "./verify/report";
import { superviseDevServer } from "./verify/stdout";
import { createVerifyRun, type VerifyDependencies } from "./verify/verify";
export function reportExitCode(results: RunState[], strict: boolean): 0 | 1 | 2 {
  if (results.some((result) => result.execution.kind === "error" && result.execution.configError)) return 2;
  if (results.some((result) => result.reconciliation.status === "pending")) return 2;
  if (results.some((result) => result.reconciliation.status === "failed")) return 1;
  return exitCode(results.map((result) => result.verdict), strict);
}
function databaseUrl(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.DATABASE_URL;
  if (!url) throw new ConfigurationError("DATABASE_URL is required for live reconciliation (read-only trace queries); pass --skip-reconcile to score without it");
  return url;
}
/** One connection for the whole CLI process, created on first use and closed in main's finally. The DATABASE_URL check runs here — inside the verify adapter — so a missing URL downgrades reconciliation to pending (exit 2) while cases still score, instead of aborting before any verdict exists. */
export function lazyPostgresFetchers(env: Readonly<Record<string, string | undefined>>): { loadDataset: VerifyDependencies["loadDataset"]; close: () => Promise<void> } {
  let fetchers: ReturnType<typeof postgresFetchers> | undefined;
  return {
    loadDataset: async (runId) => {
      fetchers ??= postgresFetchers(databaseUrl(env));
      return loadTraceDataset(fetchers, runId);
    },
    close: async () => { await fetchers?.close(); },
  };
}
function verifyDependencies(env: Readonly<Record<string, string | undefined>>, loadDataset: VerifyDependencies["loadDataset"]): VerifyDependencies {
  return { loadDataset, fetchObservations: createLangfuseObservationSource(env), workspaceId: env.POLYMATH_EVAL_WORKSPACE_ID };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes("--live");
  const skipReconcile = args.includes("--skip-reconcile");
  let dev: ReturnType<typeof superviseDevServer> | undefined;
  // Hoisted so finally can release the Postgres connection on every path.
  let lazy: ReturnType<typeof lazyPostgresFetchers> | undefined;
  try {
    const cases = caseRegistry(process.env).filter((item) => live ? !item.fixtureOnly : item.fixtureOnly);
    if (args.includes("--supervise-dev")) {
      // Readiness gates the first drive; the driver targets this base URL, so
      // the supervised server must answer there before any case runs.
      dev = superviseDevServer({
        command: process.env.POLYMATH_EVAL_DEV_COMMAND ?? "pnpm dev",
        cwd: process.env.POLYMATH_EVAL_DEV_CWD ?? "..",
        readyUrl: process.env.POLYMATH_EVAL_BASE_URL ?? "http://127.0.0.1:3000",
      });
      await dev.ready();
    }
    lazy = live && !skipReconcile ? lazyPostgresFetchers(process.env) : undefined;
    const verify = lazy ? createVerifyRun(verifyDependencies(process.env, lazy.loadDataset)) : undefined;
    const results: RunState[] = [];
    // Serial by default, matching eve maxConcurrency=1 and model quota limits.
    for (const item of cases) results.push(await createCaseGraph({ verify, captureStdout: dev?.capture }).invoke({ caseId: item.id, skipReconcile }));
    console.log(renderConsoleTable(results));
    console.log(JSON.stringify(reportJson(results), null, 2));
    process.exitCode = reportExitCode(results, args.includes("--strict"));
  } catch (error) { console.error(String(error)); process.exitCode = 2; }
  finally { await lazy?.close(); await dev?.stop(); }
}
if (import.meta.url === `file://${process.argv[1]}`) void main();
