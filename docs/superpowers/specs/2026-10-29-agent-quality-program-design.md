# Agent Quality Program: Strong-Model Plumbing, Eval Suite, MCP Surface, Work Visibility

Date: 2026-10-29
Status: Approved in conversation (grilling session, all decisions confirmed)
Benchmark: Notion "Desirable Outputs and Evals" (Polymath / Command Center)

## Purpose

Polymath's agents must reliably produce the desirable outputs the Notion page
defines, on the platform and from local tools (Claude Code over MCP). This spec
covers the foundation: strong-model plumbing, a local eval runner that reports
to PRs, the first eval expansion, an MCP capture loop, and agent work
visibility. Later batches of scenarios extend the eval suite; they are out of
scope here except for the mechanism that authors them.

## Decisions (grilling record)

1. Scenarios are authored by themed grilling batches and recorded in a new
   Notion "Eval Scenarios" database (child of the Polymath page) with fields:
   scenario id, user ask, desirable output, failure examples, eval type
   (deterministic / live-turn / LLM-judged). Each batch becomes evals.
2. Stronger models arrive through an **OpenAI-compatible endpoint**. Decision
   path: a **LiteLLM proxy fronting the Hive key** is the preferred endpoint
   when hosted at a URL both Vercel (where agent runs execute) and local
   evals can reach — it unifies spend and budgets across tools and makes
   model swaps catalog-row changes. A **direct OpenAI key** (already in
   `.env`) is the interim: working immediately, same catalog shape, swapped
   for LiteLLM later by editing catalog rows, not code. Either way the
   plumbing is one new `baseUrl` + `keyEnv` catalog entry and one
   gate-allowlist addition. OpenRouter remains the fallback if LiteLLM
   hosting is deferred and multi-vendor comparison is wanted before the
   proxy is up.
3. Strong-model routing goes through the existing `auto()` decider and the
   allowlist: routine tasks stay on free-tier flash, hard tasks route to the
   strong model. Spend cap per run.
4. MCP note/zettel writes are **direct** (the owner is the principal;
   review friction kills the loop). Proposals only for external-facing
   actions.
5. MCP v1 surface: **all manifest endpoints** (the full provider-read
   surface) plus the capture-loop writes `notes_create`, `zettel_create`,
   `zettel_link`; MCP authenticates with Polymath API keys (kind `machine`,
   same mechanism as Chrome-capture companion keys).
6. Sequencing: plumbing → eval script + two evals → first scenario batch →
   MCP server. Visibility is its own PR after the eval/script PR.
7. Work visibility means **activities**: tool calls grouped under a named
   activity, expandable steps, labels stated by the agent (intent lines) and
   pinned by an eval.

## Phase 1 — Strong-model plumbing (this PR)

### 1a. Eval environment gate: denylist → allowlist

`eve/alfred/evals/stubs.ts` denies a list of provider keys. With a strong-model
key in `.env`, evals refuse to run — yet the eval suite must be able to
exercise routed strong-model turns.

Change the gate to an **allowlist**: evals run with only `GEMINI_API_KEY`,
`GEMINI_AGENT_MODEL`, and the strong-model key (`OPENAI_API_KEY` interim;
the LiteLLM proxy key's env name when it lands). Everything else set —
Composio, Firecrawl, LlamaParse, Blob, any other provider key or
`COMPOSIO_AUTH_CONFIG_*` — still throws `EvalEnvironmentViolation` at import
time. The worker-inherits-env hazard in the current comment block stays
covered: the allowlist is closed, so a new-but-unlisted key fails rather
than silently reaching a tool.

### 1b. Model catalog: strong-model entries

`src/domains/agents/models.ts` gains entry/entries shaped like the existing
ones (`id`, `baseUrl`, `keyEnv`, `label`). Interim entry: direct OpenAI
(`baseUrl: https://api.openai.com/v1`, `keyEnv: OPENAI_API_KEY`) — a
GPT-class synthesis model. When the LiteLLM/Hive proxy is hosted, entries
point at its base URL with the proxy key instead; swapping is a catalog-row
edit. The frozen model guard (`modelById` throwing on an uncatalogued id)
applies unchanged: a run's frozen model is never silently substituted.

### 1c. Routing: `auto()` allowlist and spend cap

`MODEL_ROUTING_OPTIONS` (evals/axiom-policy.ts) gains the strong-model
entries with descriptions the decider can judge ("routine drafting" vs
"multi-step synthesis"). `ROUTING_FALLBACK` stays a free-tier model. A
per-run spend cap (million-token budget on the run row, enforced where the
run's spend is already recorded) bounds strong-model cost; exceeding it
fails the run loudly rather than downgrading silently — the same contract
as the frozen model guard. When the LiteLLM proxy arrives, its own budget
tracking becomes the enforcement point and the app-side cap becomes a
second line of defense.

## Phase 2 — Eval script and first expansion (this PR)

### 2a. `scripts/run-evals-pr.sh`

1. Sanitize env to the allowlist keys (unset everything else the gate
   forbids, including `COMPOSIO_AUTH_CONFIG_*`).
2. Run `eve eval` from `eve/alfred/` with `--json`, serial (config already
   sets `maxConcurrency: 1`).
3. On 429 (`Too Many Requests`), wait 60s and retry that eval, max 3 —
   quota is not regression.
4. Render a markdown table (eval, pass/fail, assertion labels on failure)
   and post with `gh pr comment` to the current branch's PR. Comment body
   carries a `<polymath-eval-results>` marker; the script replaces its
   previous comment instead of stacking. No PR open → write the body to a
   file. `--no-comment` dry run prints the body.

### 2b. Two evals, two patterns (`eve/alfred/evals/desirable-outputs.eval.ts`)

- `linearDraftFromPastedMaterial` — proposal pattern. Stub
  `linear_issue_propose` drafted-shape; pasted material must reach the tool
  verbatim; reply names the proposal in Reviews; never claims a Linear
  issue exists.
- `whatIsOnMyPlateToday` — synthesis pattern. Stubs: `tasks_read` (5 open,
  2 due today), `tasks_recent` (2 completed), empty calendar. Progress is
  composed from `tasks_recent` first; due dates surface; the calendar gap
  is named in one line, not opened with.

Both follow chat-grounding's pattern: `installEvalGuard`, `quietStubs()`
with per-test overrides, matcher properties not exact phrasings. A failure's
assertion label becomes a candidate few-shot `<example>` in
`instructions.md` — eval failure → example block is the pipeline.

## Phase 3 — First scenario batch (next PR)

Grill themed batches (capture, briefing, research, writing, review), record
approved scenarios in the Notion database, implement each batch as evals.
The two Phase-2 evals are the templates.

## Phase 4 — Polymath MCP surface (own PR)

The gateway at `/api/mcp` already speaks `initialize` / `tools/list` /
`tools/call` with auth and a manifest (`src/domains/integrations/tool-manifest.ts`).

### 4a. Authentication: the Polymath API key

MCP clients authenticate with the **same API-key mechanism Polymath's Chrome
extension uses for captures**: an `axm_<keyId>.<secret>` bearer minted in
Settings → Account, hashed in the `api_clients` table
(`src/domains/identity/schema.ts:247`, kinds `companion` | `machine`,
scopes, status, expiry). MCP connections mint a key of kind `machine` with
an MCP scope set; the `/api/mcp` route verifies the bearer and resolves the
workspace/principal exactly as capture routes do. No new auth type, no new
principal shape — a capture key and an MCP key are the same credential with
different scopes.

### 4b. Tool surface: v1 = all manifest endpoints

The v1 MCP surface is **everything the tool manifest already exposes** —
all provider reads (gmail_search, googlecalendar_list_events, linear_*,
github_*, slack_*, notion_*, googledrive/docs/sheets, hubspot, and the rest
of the ~28 manifest tools) plus the internal tools (documents_search,
tasks_read, wiki_read, records_browse, notebook_open) — so anything Polymath's
own agents can read, Claude Code can read through MCP. On top of that
complete read surface, v1 adds the capture loop writes: `notes_create`,
`zettel_create`, `zettel_link`.

- Writes are direct for the authenticated owner; the provenance marker
  records "created via MCP." External-facing actions (gmail_send already
  routes to a proposal) stay proposal-only.
- Scopes gate the surface: an MCP key scoped narrowly sees a filtered
  tools/list, enforced at call time per the existing policy.
- Eval coverage for the write tools lands with the batch that grills the
  capture loop; read tools inherit the same stub discipline as platform
  evals.

## Phase 5 — Work visibility (own PR)

The stream contract already carries tool frames
(`stream-contract.ts:34`: `label`, `status: running|ok|error`, `detail`,
`input`); labels currently fall back to the raw tool name and calls are
ungrouped.

- **Intent lines**: the agent states one human line before each call
  ("Searching your lease document"), prompted in `instructions.md` and
  pinned by an eval (a model that skips the line fails visibly).
- **Activities**: consecutive tool calls group under one named activity
  with expandable steps (input/output detail); the frame contract gains an
  activity grouping field; the UI renders groups.
- Deterministic label tables are rejected: they cannot cover unknown
  inputs and go stale as tools change.

## Testing

- Evals are the test for live behavior (Phase 2b/5).
- The gate change gets a unit test: listed keys pass, one forbidden key
  throws, empty env throws on the first eval needing a model credential.
- The script gets `--no-comment` and runs in CI-independent local use.
- Catalog/routing changes are pinned by extending `routing.eval.ts`
  (off-allowlist strong-model answers still rejected).

## Risks

- Strong-model endpoint latency/availability differs from Gemini direct;
  the frozen model contract means a route to the strong model is a
  commitment for the run.
- LLM-judged eval types (needed by some scenarios) do not exist in the
  harness yet; introduced with Phase 3, not before.
- MCP direct writes bypass the review queue; bounded by scope (notes and
  zettels only) and provenance markers. Read-surface breadth is bounded by
  scopes on the machine key, not by trust in the client.
- The interim OpenAI key is a single-vendor lock-in for strong-model work
  until the LiteLLM/Hive proxy is hosted; the catalog abstraction keeps the
  later swap to config.
