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
 * The eval environment gate is a closed allowlist over credential-shaped keys:
 * an eval may run with only these credentials set, and any other credential in
 * the environment throws at import time — the eval never starts, which is the
 * only outcome that cannot be mistaken for a pass. A key is credential-shaped
 * when it ends with `_KEY`, `_TOKEN`, or `_SECRET`, contains `API_KEY`, or
 * starts with `COMPOSIO_AUTH_CONFIG_` (an auth-config id is all a real tool
 * needs to mint a link for a connected account). Structural variables (PATH,
 * HOME, locale and harness vars) are not credentials and pass; a provider key
 * this file has never heard of (a future `XAI_API_KEY`) still fails, which a
 * denylist cannot do. This is the same incident guard as before (a stub the
 * model slips past reaching the owner's mail, recorded in chat-grounding.eval.ts).
 *
 * OPENAI_API_KEY is allowed because routed strong-model eval turns need it. The
 * agent worker inherits this exact environment (`new Worker(entry, { env:
 * process.env })`), so any other provider credential left set is reachable from
 * inside a tool, not just the eval process — the worker-inherits-env hazard is
 * about credentials, and this gate covers the worker where the network guard
 * does not. `quietStubs()` is what keeps tools from reaching real providers;
 * `tests/unit/eval-stub-coverage.test.ts` holds that line.
 */
export const ALLOWED_EVAL_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_AGENT_MODEL",
  "OPENAI_API_KEY",
] as const;

function isCredentialShaped(key: string): boolean {
  return (
    key.endsWith("_KEY") ||
    key.endsWith("_TOKEN") ||
    key.endsWith("_SECRET") ||
    key.includes("API_KEY") ||
    key.startsWith("COMPOSIO_AUTH_CONFIG_")
  );
}

/*
 * CI-harness credentials are injected by the runner itself, not by the
 * operator: GitHub Actions exports ACTIONS_RUNTIME_TOKEN (artifact upload
 * auth) and ACTIONS_CACHE_SERVICE_TOKEN into every step, and gh CLI
 * authenticates with GH_TOKEN/GITHUB_TOKEN. They are credential-shaped, but
 * they are not provider credentials a tool could spend — and the evals CI
 * job's token is scoped to contents:read + pull-requests:write. Exempting
 * these harness names keeps the gate closed for operator keys while letting
 * the evals CI job and gh-authenticated local runs work at all.
 */
const HARNESS_ENV_PREFIXES = ["ACTIONS_", "GITHUB_", "RUNNER_"] as const;
const HARNESS_ENV_NAMES = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

function isHarnessInjected(key: string): boolean {
  return (
    HARNESS_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) || HARNESS_ENV_NAMES.has(key)
  );
}

export class EvalEnvironmentViolation extends Error {
  constructor(key: string) {
    super(
      `EvalEnvironmentViolation: ${key} is set. ${key} is not on the eval allowlist; ` +
        `unset it before running \`eve eval\`.`,
    );
    this.name = "EvalEnvironmentViolation";
  }
}

/**
 * Throw when any credential outside `ALLOWED_EVAL_ENV` is present. Structural
 * variables (PATH, HOME, ...) are not credentials and pass. Called at import
 * time by every eval module, so a misconfigured eval fails before a turn starts.
 */
export function assertEvalEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  for (const key of Object.keys(env)) {
    if (
      !(ALLOWED_EVAL_ENV as readonly string[]).includes(key) &&
      isCredentialShaped(key) &&
      !isHarnessInjected(key) &&
      isSet(env[key])
    ) {
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
  artifacts_propose_revision: { response: { ok: true, proposalId: "00000000-0000-0000-0000-000000000000", deduplicated: false, status: "awaiting review" } },
  // ASH-282: the read returns an empty calendar, the write only ever proposes.
  calendar_conflicts: { response: { ok: true, windowStart: "", windowEnd: "", timezone: "UTC", conflicts: [], notices: [] } },
  calendar_conflict_propose: { response: { ok: true, proposalId: "00000000-0000-0000-0000-000000000000", deduplicated: false, status: "awaiting owner approval" } },
  documents_search: { response: { ok: true, query: "", results: [] } },
  // ASH-279 / ASH-283: both only ever propose, so the stub is the "queued"
  // shape and an eval can never reach Notion or spend a generation call.
  meeting_debrief: { response: { ok: true, status: "awaiting review", proposed: 0, taskProposalIds: [], noteProposalIds: [], followUpProposalIds: [], deduplicated: 0 } },
  // ASH-285: only ever drafts a proposal note, so the stub is the "drafted"
  // shape and an eval can never reach Linear or spend a generation call.
  linear_issue_propose: { response: { ok: true, status: "drafted", artifactId: "00000000-0000-0000-0000-000000000000", title: "Linear issue: stub", generated: false, outcome: "created" } },
  // ASH-284: decision-only triage proposal; the stub can never reach GitHub.
  github_triage_propose: { response: { ok: true, status: "proposed", proposalId: "00000000-0000-0000-0000-000000000000", deduplicated: false } },
  notion_propose_update: { response: { ok: true, proposalId: "00000000-0000-0000-0000-000000000000", deduplicated: false, contentHash: "", status: "awaiting review" } },
  // ASH-287: proposes only, so the stub is the queued outcome.
  crm_propose_contacts: { response: { ok: true, status: "awaiting review", proposed: [], skipped: [] } },
  notebook_open: { response: { ok: true, notebook: null } },
  "polymath-gateway__gmail_read_thread": { response: { ok: false, error: "not connected in this eval" } },
  "polymath-gateway__gmail_search": { response: { ok: false, error: "not connected in this eval" } },
  "polymath-gateway__gmail_send": { response: { ok: false, error: "not connected in this eval" } },
  // ASH-306 / ASH-293: reads and one-hop expansion, both with an empty graph
  // so an eval asserts the tool was called, not what the live library holds.
  records_browse: { response: { ok: true, kind: "task", query: null, total: 0, records: [] } },
  research_deepen: { response: { ok: true, seed: null, added: [], candidates: [], budget: { hopsUsed: 0, hopsRemaining: 8, hopsMax: 8, callsUsed: 0, callsMax: null } } },
  tasks_propose: { response: { ok: true, proposalId: "00000000-0000-0000-0000-000000000000", deduplicated: false, status: "awaiting review" } },
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
