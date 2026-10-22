import type { ToolStubOutcome } from "eve/evals";

/*
 * One list every eval's stubs are built from, and one environment gate.
 *
 * eve's stub layer calls the real tool whenever no stub matches
 * (`tool-stubs/execute.js` -> `executeWithToolStub` -> `i === void 0 ? r() : ...`,
 * and `StubPlayback.call` returns `{ kind: "real" }` for an unmatched tool). A
 * tool added to `agent/tools/` therefore starts reaching production the moment
 * it exists, whether or not an eval knows about it. This file is the single
 * place that list is declared; `tests/unit/eval-stub-coverage.test.ts` fails when
 * a tool file has no entry, which is the static half of the guard.
 */

/*
 * Provider credentials beyond the model key must not be present while an eval
 * runs. With them set, a stub the model slips past (or one this file forgot)
 * becomes a real read of the owner's mail or a real Firecrawl/Composio call —
 * the incident recorded in chat-grounding.eval.ts. Failing at import time means
 * the eval never starts, which is the only outcome that cannot be mistaken for
 * a pass.
 *
 * The model key is allowed since chat-grounding drives a live turn. The keys are
 * process-wide, though, and the agent runs in its own worker that inherits this
 * environment (`new Worker(entry, { env: process.env })`), so a provider key
 * left set is reachable from inside a tool, not just from the eval process. That
 * is why this is the guard that covers the worker and the network guard does not.
 */
const FORBIDDEN_ENV = [
  "COMPOSIO_API_KEY",
  "FIRECRAWL_HOSTED_API_KEY",
  "FIRECRAWL_API_KEY",
  "LLAMAPARSE_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "BLOB_READ_WRITE_TOKEN",
] as const;

// A Composio auth-config id is not itself a secret, but it is all a real tool
// needs to mint a link for a connected account, so it counts as provider access.
const FORBIDDEN_PREFIXES = ["COMPOSIO_AUTH_CONFIG_"] as const;

export class EvalEnvironmentViolation extends Error {
  constructor(key: string) {
    super(
      `EvalEnvironmentViolation: ${key} is set. Evals run with only the model credential; ` +
        `remove ${key} from the shell and from .env before running \`eve eval\`.`,
    );
    this.name = "EvalEnvironmentViolation";
  }
}

/**
 * Throw when any provider credential is present. Called at import time by every
 * eval module, so a misconfigured eval fails before a turn starts.
 */
export function assertEvalEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const key of FORBIDDEN_ENV) {
    if (isSet(env[key])) throw new EvalEnvironmentViolation(key);
  }
  for (const key of Object.keys(env)) {
    if (FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix)) && isSet(env[key])) {
      throw new EvalEnvironmentViolation(key);
    }
  }
}

function isSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

/*
 * Every authored tool, with the outcome it returns in an eval where the point is
 * the agent's behaviour rather than the provider's answer. A tool absent here is
 * a tool that runs for real.
 */
/*
 * The provider tools arrive through the `polymath-gateway` MCP connection, so
 * eve exposes them as `<connection>__<tool>` (connections/ownership.js:
 * `connectionToolName`). Stubbing the bare `gmail_search` would match nothing
 * and the real tool would run — the failure this file exists to prevent.
 */
export const STUBBED_TOOLS = {
  documents_search: { response: { ok: true, query: "", results: [] } },
  learning_grade: { response: { ok: true } },
  learning_next: { response: { ok: true, items: [] } },
  notebook_open: { response: { ok: true, notebook: null } },
  "polymath-gateway__gmail_read_thread": { response: { ok: false, error: "not connected in this eval" } },
  "polymath-gateway__gmail_search": { response: { ok: false, error: "not connected in this eval" } },
  "polymath-gateway__gmail_send": { response: { ok: false, error: "not connected in this eval" } },
  tasks_read: { response: { ok: true, tasks: [] } },
  tasks_recent: { response: { ok: true, tasks: [], days: 7 } },
  web_fetch: { response: { ok: true, text: "" } },
  web_search: { response: { ok: true, results: [] } },
  wiki_ingest: { response: { ok: true } },
  wiki_lint: { response: { ok: true, findings: [] } },
  wiki_read: { response: { ok: true, articles: [] } },
} satisfies Readonly<Record<string, ToolStubOutcome>>;

/*
 * Inference, not a hand-written return type: the SDK's stub shape is a union
 * discriminated on `outcome` vs `outcomes`, and annotating the return widened it
 * into a type the runner rejects.
 *
 * Order matters to the playback layer: it picks the first rule whose `tool`
 * matches, so an eval's specific stub placed before this spread wins.
 */
export function quietStubs() {
  return Object.entries(STUBBED_TOOLS).map(([tool, outcome]) => ({
    id: `quiet-${tool}`,
    tool,
    outcome,
  }));
}
