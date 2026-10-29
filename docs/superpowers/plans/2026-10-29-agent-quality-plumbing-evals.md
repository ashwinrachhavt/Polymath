# Agent Quality Plumbing + Eval Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a strong-model key through the model catalog and eval gate, add a local eval runner that posts results as PR comments, and pin two desirable-output behaviors with live evals.

**Architecture:** The model catalog (`src/domains/agents/models.ts`) is the single place a provider enters the system — one `ModelOption` entry with `baseUrl` + `keyEnv`. The eval environment gate in `eve/alfred/evals/stubs.ts` flips from a denylist to a closed allowlist so the strong key can ride eval turns while every other provider credential still fails closed. Evals follow the existing chat-grounding pattern (stub every tool, drive a live Gemini turn, assert on behavior). The runner script wraps `eve eval --json`, retries quota errors, and posts a replaceable markdown comment to the branch's PR.

**Tech Stack:** TypeScript (Next.js repo), eve agent framework v0.76.3 (`eve eval` CLI), drizzle/pg (schema untouched), bash + `gh` CLI for the runner.

**Spec:** `docs/superpowers/specs/2026-10-29-agent-quality-program-design.md` (Phases 1 and 2 only; Phases 3–5 are later plans)

## Global Constraints

- Eval runs are **serial**: `maxConcurrency: 1` in `eve/alfred/evals/evals.config.ts`. Never raise it; free-tier Gemini 429s under burst.
- The frozen-model contract: a run's frozen model is never silently substituted (`modelById` throws on an uncatalogued id).
- Evals must never touch production data: every authored tool stays stubbed via `quietStubs()`; the network guard (`installEvalGuard`) is installed per test and restored in `finally`.
- Catalog entries without a live probe are marked `"listing <date> …"` in `probe` and only surface when their key is set (repo convention, `models.ts:14-17`).
- A failing spend reservation fails the run loudly — `"Spend ceiling exceeded"` (`engine.ts:233-237`); no silent downgrade.
- Worktree discipline: run all commands from this directory; do not `cd` to the repo root's main checkout.

## Review Focus

- **A tool call slipping its stub when `OPENAI_API_KEY` is allowlisted** — the key becomes reachable inside the agent worker, so a missing stub entry is a real provider call, not a stub miss. Expect `quietStubs()` coverage (the unit test from `tests/unit/eval-stub-coverage.test.ts`) to keep failing on any uncovered tool. Pinned by: the existing coverage test, run in Task 1 Step 4.
- **A 429 reading as a regression** — "Too Many Requests" with empty assertion detail is quota, not behavior. Expect the runner to retry, and a human reading a red row to check the error text first. Pinned by: Task 4's retry step (simulate by running twice in quick succession).
- **Alfred summarizing pasted material instead of passing it verbatim** — the linear-draft tool's contract is verbatim text ("do not summarise it first"); a summarized pass loses the details acceptance criteria need. Pinned by: Task 5 asserts the stub received the full pasted string.
- **Progress composed from open tasks instead of completed ones** — "what did I get done" answered from `tasks_read` inverts the instructions (`instructions.md:109-112`). Pinned by: Task 6 asserts `tasks_recent` is called and its items appear as the done-list.
- **Stacked duplicate PR comments** — a runner that posts fresh each time buries the latest results. Expect the marker-based replace to keep exactly one live comment. Pinned by: Task 4's replace step (run twice against a PR, assert one comment).

---

### Task 1: Eval environment gate — denylist to allowlist

**Files:**
- Modify: `eve/alfred/evals/stubs.ts:29-73` (the `FORBIDDEN_ENV` / `FORBIDDEN_PREFIXES` / `assertEvalEnvironment` block)
- Test: `tests/unit/eval-gate-allowlist.test.ts` (create)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `assertEvalEnvironment(env?: Readonly<Record<string, string | undefined>>): void` — unchanged signature, new semantics: throws `EvalEnvironmentViolation` for any key **not** in `ALLOWED_EVAL_ENV`. Also exports `ALLOWED_EVAL_ENV: readonly string[]` so the unit test and the runner script share one source of truth.

- [ ] **Step 1: Write the failing unit test**

Vitest, following the style of the existing unit tests in `tests/unit/`:

```ts
import { describe, expect, it } from "vitest";
import { EvalEnvironmentViolation, assertEvalEnvironment } from "../../eve/alfred/evals/stubs";

describe("assertEvalEnvironment", () => {
  it("allows exactly the declared eval keys", () => {
    const env = { GEMINI_API_KEY: "k", GEMINI_AGENT_MODEL: "gemini-3.5-flash-lite", OPENAI_API_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });

  it("throws for any provider key outside the allowlist", () => {
    const env = { GEMINI_API_KEY: "k", COMPOSIO_API_KEY: "k" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("throws for COMPOSIO_AUTH_CONFIG_ prefixed keys", () => {
    const env = { COMPOSIO_AUTH_CONFIG_GMAIL: "cfg" };
    expect(() => assertEvalEnvironment(env)).toThrow(EvalEnvironmentViolation);
  });

  it("treats a blank-string key as unset", () => {
    const env = { COMPOSIO_API_KEY: "   " };
    expect(() => assertEvalEnvironment(env)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run tests/unit/eval-gate-allowlist.test.ts`
Expected: FAIL — `assertEvalEnvironment` currently throws on `OPENAI_API_KEY` (it is in the denylist), so the first assertion fails.

- [ ] **Step 3: Implement the allowlist in `stubs.ts`**

Replace `FORBIDDEN_ENV` + `FORBIDDEN_PREFIXES` with:

```ts
export const ALLOWED_EVAL_ENV = [
  "GEMINI_API_KEY",
  "GEMINI_AGENT_MODEL",
  "OPENAI_API_KEY",
] as const;
```

`assertEvalEnvironment` keeps its signature and error type; the loop inverts: iterate `Object.keys(env)`, and for any key not in `ALLOWED_EVAL_ENV` whose value `isSet`, throw `EvalEnvironmentViolation(key)` with the same message shape (reword "remove X" → "X is not on the eval allowlist; unset it before running `eve eval`"). Update the comment block above it: the allowlist is closed, the agent worker inherits this exact environment, and `OPENAI_API_KEY` is present because routed strong-model eval turns need it — `quietStubs()` is what keeps tools from reaching real providers, and `tests/unit/eval-stub-coverage.test.ts` holds that line.

- [ ] **Step 4: Run both gate tests and the stub-coverage test**

Run: `pnpm vitest run tests/unit/eval-gate-allowlist.test.ts tests/unit/eval-stub-coverage.test.ts`
Expected: PASS (both files).

- [ ] **Step 5: Verify the real evals still pass the gate with a sanitized shell**

Run: `cd eve/alfred && env -u COMPOSIO_API_KEY -u COMPOSIO_AUTH_CONFIG_GMAIL -u OPENROUTER_API_KEY -u GROQ_API_KEY node_modules/.bin/eve eval --list`
Expected: the eval list prints (no `EvalEnvironmentViolation` thrown at import). Note: `.env` keys still load through eve's dotenv handling; the runner script in Task 4 handles full sanitization — here we only prove the gate no longer rejects the model keys.

- [ ] **Step 6: Commit**

```bash
git add eve/alfred/evals/stubs.ts tests/unit/eval-gate-allowlist.test.ts
git commit -m "feat(evals): flip the eval environment gate to a closed allowlist"
```

---

### Task 2: Model catalog — OpenAI strong-model entry

**Files:**
- Modify: `src/domains/agents/models.ts` (`ModelProviderId` union + `MODEL_CATALOG`)

**Interfaces:**
- Consumes: the live `OPENAI_API_KEY` already present in `.env`.
- Produces: a catalog entry with `provider: "openai"`, `keyEnv: "OPENAI_API_KEY"`, whose exact `id` is pinned by this task's probe step. Later tasks reference it as the routing option for hard tasks.

- [ ] **Step 1: Probe the live key for the strongest available chat model**

The repo convention (`models.ts:7-11`) is: never ship an entry that does not answer. Probe before pinning the id.

Run (key read from `.env` by the shell profile; if not exported, source it first — never print the key):

```bash
set -a && source .env && set +a && curl -s https://api.openai.com/v1/models -H "Authorization: Bearer $OPENAI_API_KEY" | python3 -c "import json,sys; ids=[m['id'] for m in json.load(sys.stdin)['data']]; print('\n'.join(sorted(i for i in ids if i.startswith(('gpt-','o')))))"
```

Expected: a list of model ids. Pick the strongest general chat/reasoning model available to this key (prefer the newest flagship `gpt-*` over mini/nano variants). Record the chosen id — it is the `id` in Step 2 and is referenced in Task 3 as `openai-strong-model-id`.

If the probe fails (network, key invalid): STOP — report the failure to the operator and skip to Task 4; the catalog entry ships only after a successful probe or is marked `listing` with the reason.

- [ ] **Step 2: Add the provider id and catalog entry**

In `models.ts`:

1. Extend the union: `export type ModelProviderId = ... | "openai";` (alphabetical position, after `"nvidia"`).
2. Append to `MODEL_CATALOG`:

```ts
{
  id: "<openai-strong-model-id>",       // from Step 1, e.g. "gpt-5.1"
  provider: "openai",
  label: "<Model name> (OpenAI)",       // picker label matching the probed id
  note: "Paid strong model for hard synthesis and drafting; routed by task difficulty.",
  baseUrl: "https://api.openai.com/v1",
  keyEnv: "OPENAI_API_KEY",
  probe: "live <today's date> (models listing; chat turn probed in Task 3's live eval run)",
},
```

Also add a second entry for a cheaper OpenAI model from the Step-1 listing (a `mini`/`small` variant) with note "Cheaper paid route for routine paid work", same `baseUrl`/`keyEnv`, only if the listing shows one; omit if not.

- [ ] **Step 3: Verify the catalog loads and the entry resolves**

Run: `pnpm vitest run tests/unit --silent` (any existing model-catalog tests) and `pnpm tsc --noEmit`
Expected: PASS, no type errors — the union extension and entry compile.

- [ ] **Step 4: Commit**

```bash
git add src/domains/agents/models.ts
git commit -m "feat(agents): add OpenAI strong-model entries to the catalog"
```

---

### Task 3: Routing — real ids in the allowlist and eval fixtures

**Files:**
- Modify: `eve/alfred/evals/axiom-policy.ts:109-121` (`MODEL_ROUTING_OPTIONS`, `ROUTING_FALLBACK`)
- Modify: `eve/alfred/evals/routing.eval.ts` (fixture decider answers and assertions only)

**Interfaces:**
- Consumes: Task 2's `<openai-strong-model-id>`; `DEFAULT_MODEL_ID` = `"gemini-3.5-flash-lite"` from `models.ts`.
- Produces: `MODEL_ROUTING_OPTIONS` keys are **real catalog ids**: `"gemini-3.5-flash-lite"` (routine) and `<openai-strong-model-id>` (hard). `ROUTING_FALLBACK = "gemini-3.5-flash-lite"` (the free-tier model — routing fails safe to free).

- [ ] **Step 1: Update the routing eval first (TDD — it pins the new contract)**

In `routing.eval.ts`, the fixture deciders currently answer `"anthropic/claude-sonnet-5"` and `"anthropic/claude-opus-5.5"`. Change them to answer the new ids: the routine fixture returns `"gemini-3.5-flash-lite"`, the hard fixture returns `"<openai-strong-model-id>"`; the off-allowlist fixture stays `"attacker/unpriced-model"`. Update the assertion strings (`includes("claude-sonnet-5")` → `includes("gemini-3.5-flash-lite")`, likewise the hard route) and the two labels.

Run: `cd eve/alfred && env -u COMPOSIO_API_KEY -u COMPOSIO_AUTH_CONFIG_GMAIL node_modules/.bin/eve eval routing`
Expected: FAIL — `MODEL_ROUTING_OPTIONS` still holds the anthropic ids, so `resolveRoute` rejects the new answers.

- [ ] **Step 2: Update `axiom-policy.ts` to the real ids**

```ts
export const MODEL_ROUTING_OPTIONS: Readonly<Record<string, string>> = {
  "gemini-3.5-flash-lite": "Routine conversation, drafting, tool loops, and summaries — free tier",
  "<openai-strong-model-id>": "Difficult reasoning: multi-step research, planning, synthesis, and ambiguous policy questions — paid strong model",
};

export const ROUTING_FALLBACK = "gemini-3.5-flash-lite";
```

Delete the comment block above it if it references the anthropic fixture ids; one line replaces it: keys must be real `MODEL_CATALOG` ids so a routed answer is always a runnable model.

- [ ] **Step 3: Run the routing eval to verify it passes**

Run: `cd eve/alfred && env -u COMPOSIO_API_KEY -u COMPOSIO_AUTH_CONFIG_GMAIL node_modules/.bin/eve eval routing`
Expected: PASS (fixture decider; no live model calls).

- [ ] **Step 4: Spend-cap verification (spec §1c — already implemented, prove it)**

`reserveSpend` enforces `perRunCeilingUsd`/daily ceilings and the engine fails the run loudly (`engine.ts:233-237`). No code change. Verify the existing test coverage:

Run: `pnpm vitest run tests/unit -t spending --silent || true; ls tests/unit | grep -i spend`
Expected: a spending test file exists and passes; if none exists, note the gap in the PR description rather than writing one here (the spending domain predates this plan and its ceiling logic is out of scope).

- [ ] **Step 5: Commit**

```bash
git add eve/alfred/evals/axiom-policy.ts eve/alfred/evals/routing.eval.ts
git commit -m "feat(evals): route over real catalog ids with a free-tier fallback"
```

---

### Task 4: The eval runner script with PR comments

**Files:**
- Create: `scripts/run-evals-pr.sh`

**Interfaces:**
- Consumes: `ALLOWED_EVAL_ENV` (Task 1, for the documented key list), `eve eval --json` output shape, `gh` CLI authenticated as the owner.
- Produces: `scripts/run-evals-pr.sh [--no-comment] [evalIds...]` — exit 0 iff all evals pass after retries; with a PR open, exactly one `<polymath-eval-results>`-marked comment reflecting the latest run.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Run Polymath agent evals locally and post results to the branch's PR.
# Usage: scripts/run-evals-pr.sh [--no-comment] [evalIds...]
set -euo pipefail
cd "$(dirname "$0")/../eve/alfred"

COMMENT_MARKER="<polymath-eval-results>"
POST=true; [ "${1:-}" = "--no-comment" ] && { POST=false; shift; }

# Env sanitize: evals run with only the allowlisted model credentials
# (eve/alfred/evals/stubs.ts ALLOWED_EVAL_ENV). Unset everything else, incl.
# every COMPOSIO_AUTH_CONFIG_* — the gate throws on any other set key.
ALLOWED=(GEMINI_API_KEY GEMINI_AGENT_MODEL OPENAI_API_KEY)
while IFS='=' read -r name _; do
  [ -z "$name" ] && continue
  keep=false
  for a in "${ALLOWED[@]}"; do [ "$name" = "$a" ] && keep=true; done
  if ! $keep; then unset "$name"; fi
done < <(env | cut -d= -f1)
# .env still leaks through eve's dotenv loader for the keys it defines; the
# gate is the authority — this shell cleanup just keeps the common case quiet.

run_one() { # $1 = eval id; retries quota errors up to 3x with a 60s backoff
  local attempt=1 out
  while :; do
    if out=$(node_modules/.bin/eve eval "$1" --json 2>&1); then printf '%s' "$out"; return 0; fi
    if grep -q "Too Many Requests" <<<"$out" && [ $attempt -lt 3 ]; then
      echo "429 on $1, attempt $attempt — waiting 60s (quota is not regression)" >&2
      sleep 60; attempt=$((attempt+1)); continue
    fi
    printf '%s' "$out"; return 1
  done
}

declare -a FAILED=(); declare -a ROWS=()
for id in "$@"; do
  out=$(run_one "$id" || true)
  if jq -e '.succeeded == true' >/dev/null 2>&1 <<<"$out"; then
    ROWS+=("| \`$id\` | ✅ pass | |")
  else
    FAILED+=("$id")
    label=$(jq -r '.assertions // empty | map(select(.passed == false)) | map(".label") | join("; ")' <<<"$out" 2>/dev/null || echo "")
    ROWS+=("| \`$id\` | ❌ fail | ${label:-see log} |")
    printf '%s\n' "$out" > "/tmp/eval-$id.log"
  fi
done

body=$(mktemp)
{
  echo "$COMMENT_MARKER"
  echo "## Polymath eval results"
  echo ""
  echo "| eval | result | failed assertions |"
  echo "| --- | --- | --- |"
  printf '%s\n' "${ROWS[@]:-| (none) | — | |}"
  echo ""
  echo "_Ran $(date -u +%Y-%m-%dT%H:%MZ); serial; 429s retried ×3._"
} > "$body"

if $POST; then
  pr=$(gh pr view --json number -q .number 2>/dev/null || true)
  if [ -z "$pr" ]; then
    echo "No open PR for this branch; comment body at $body"; cat "$body"; exit ${#FAILED[@]} > /dev/null || true
  fi
  old=$(gh api "repos/{owner}/{repo}/issues/$pr/comments" --jq ".[] | select(.body | startswith(\"$COMMENT_MARKER\")) | .id" | head -1)
  [ -n "$old" ] && gh api -X DELETE "repos/{owner}/{repo}/issues/comments/$old" >/dev/null
  gh pr comment "$pr" --body-file "$body" >/dev/null
  echo "Posted eval results to PR #$pr"
else
  cat "$body"
fi
[ ${#FAILED[@]} -eq 0 ] || exit 1
```

Then: `chmod +x scripts/run-evals-pr.sh`.

- [ ] **Step 2: Dry-run against the fixture eval**

Run: `scripts/run-evals-pr.sh --no-comment routing`
Expected: a markdown table prints with `routing` ✅ pass (Task 3 made it pass), no network calls to any provider beyond the loopback control plane.

- [ ] **Step 3: Verify the retry path and the exit code**

Run twice in quick succession — the second run should trip Gemini's per-minute window:

Run: `scripts/run-evals-pr.sh --no-comment chat-grounding && scripts/run-evals-pr.sh --no-comment chat-grounding; echo "exit=$?"`

Expected: at least one run shows the `429 … waiting 60s` line and then either passes or fails with assertion detail (never a bare 429 as the final verdict). `exit=1` only when an eval genuinely failed. (These are live-Gemini runs; ~2 model turns each.)

- [ ] **Step 4: Verify the PR-comment path**

Open the PR for this branch first (see Task 6 Step 5), then:

Run: `scripts/run-evals-pr.sh routing && scripts/run-evals-pr.sh routing`
Expected: `Posted eval results to PR #<n>` twice, and `gh api repos/{owner}/{repo}/issues/<n>/comments --jq 'length'` (filtered to the marker) shows exactly one comment — the second replaced the first. Delete the comment afterwards to keep the PR clean during review, or leave it as the live results thread.

- [ ] **Step 5: Commit**

```bash
git add scripts/run-evals-pr.sh
git commit -m "feat(scripts): local eval runner that posts replaceable PR comments"
```

---

### Task 5: Eval — Linear draft from pasted material (proposal pattern)

**Files:**
- Create: `eve/alfred/evals/desirable-outputs.eval.ts`
- Modify: `eve/alfred/evals/stubs.ts` — none (the `linear_issue_propose` quiet stub already exists; this eval overrides it per test)

**Interfaces:**
- Consumes: `defineEval`, `includes`, `satisfies` from `eve/evals`/`eve/evals/expect`; `installEvalGuard` (harness.ts); `quietStubs` (stubs.ts). Same pattern as `chat-grounding.eval.ts`.
- Produces: exported `linearDraftFromPastedMaterial` eval case; the file's default export starts as `[linearDraftFromPastedMaterial]` and gains Task 6's case.

- [ ] **Step 1: Write the eval**

Follow `chat-grounding.eval.ts` structure exactly (guard install/restore in `try/finally`, `assertEvalEnvironment()` at module top, `tags: ["desirable-outputs"]`):

- Session stubs: the specific `linear_issue_propose` stub **placed before** `...quietStubs()` (playback picks the first matching rule — `stubs.ts:126-128`), capturing what the model passed. The stub outcome is the drafted shape from `stubs.ts:97` but with a title proving which tool call it was.
- User message: paste a realistic bug report (~120 words) containing one distinctive verbatim phrase, e.g. `"The inbox badge shows 3 unread after I archived everything — the count is not decrementing on archive"` — plus the ask: "turn this into a Linear issue".
- Assertions:
  1. `turn.calledTool("linear_issue_propose")` — the proposal path is taken.
  2. The captured tool input's `text` field **contains the distinctive phrase verbatim** (`includes(...)`) — material reached the tool unsummarized.
  3. The captured input's `text` does **not** drop the tail of the paste (assert a second, late-in-the-paste phrase is present).
  4. `turn.message` matches a "proposal/draft waiting for review" property matcher (`includes(/proposal|draft|review/i)`) — the reply frames it as a draft, not a created issue.
  5. `turn.message` does **not** match `includes(/created (an|the) issue|filed|submitted to Linear/i)` — never claims a Linear issue exists.

- [ ] **Step 2: Run it live**

Run: `scripts/run-evals-pr.sh --no-comment desirable-outputs` (or `cd eve/alfred && node_modules/.bin/eve eval desirable-outputs --json`)
Expected: FAIL on first run is common and useful — likely failures are the model summarizing the paste (assertion 2/3) or claiming creation (assertion 5). Each failure is a candidate few-shot `<example>` for `instructions.md` (record it in the PR description; do not edit the prompt in this task).

- [ ] **Step 3: Iterate to green, then pin**

If a failure is a genuine behavior gap the prompt should already cover, fix the *eval's* stub/matcher fidelity first; only if the matcher is wrong do you adjust it (property matchers, never exact phrasings). Re-run until PASS.

- [ ] **Step 4: Commit**

```bash
git add eve/alfred/evals/desirable-outputs.eval.ts
git commit -m "feat(evals): pin the linear-draft proposal pattern from desirable outputs"
```

---

### Task 6: Eval — "What is on my plate today" (synthesis pattern) + open the PR

**Files:**
- Modify: `eve/alfred/evals/desirable-outputs.eval.ts` (add the second case + default export)

**Interfaces:**
- Consumes: same harness pieces as Task 5; stub shapes from `stubs.ts` for `tasks_read` (`{ ok, tasks, limit }`), `tasks_recent` (`{ ok, tasks, days }` — `completedAt` ISO strings, `tasks_recent.ts:41-44`), `calendar_conflicts` (`{ ok, windowStart, windowEnd, timezone, conflicts, notices }`).
- Produces: `whatIsOnMyPlateToday` eval; default export `[groundedDraft, plateToday]`.

- [ ] **Step 1: Write the eval**

Second case in the same file:

- Stubs: `tasks_read` → 5 open tasks, exactly 2 with `dueDate` = today (use a fixed date string the stub controls; the model sees only the stub's data), each task `{ id, title, dueDate }`. `tasks_recent` → 2 completed tasks with `completedAt` ISO strings inside the last week. `calendar_conflicts` → empty (the quiet stub's shape). All other tools quiet.
- User message: `"What is on my plate today?"`
- Assertions:
  1. `turn.calledTool("tasks_recent")` — progress is sourced from completed work.
  2. `turn.calledTool("tasks_read")` — remaining work from open tasks.
  3. `turn.message` includes both completed task titles — the done-list is real.
  4. `turn.message` includes both today-due open task titles — the deadline layer surfaces.
  5. The reply's **first sentence does not match** `includes(/no (calendar|meetings)|cannot see/i)` — the gap may be named, but not opened with (`instructions.md:11-17`: never open with missing-records).

- [ ] **Step 2: Run it live**

Run: `scripts/run-evals-pr.sh --no-comment desirable-outputs`
Expected: iterate to PASS as in Task 5 Step 3. Watch for the composition order failure (assertion 3): if the model leads with open tasks, that is the few-shot candidate — record it.

- [ ] **Step 3: Run the full eval suite once**

Run: `scripts/run-evals-pr.sh --no-comment`
Expected: all evals pass (routing, approval-classifier, chat-grounding, desirable-outputs). Serial; expect several minutes. If a 429 survives all retries, wait 60s and rerun just that eval.

- [ ] **Step 4: Lint and typecheck the whole branch**

Run: `pnpm tsc --noEmit && pnpm lint`
Expected: clean. (Memory note: lint warnings have been noisy in past branches — fix what this branch touched, report pre-existing ones.)

- [ ] **Step 5: Open the PR**

```bash
git push -u origin agents-tooling-robustness
gh pr create --title "Agent quality: strong-model plumbing, eval runner, desirable-output evals" --body "$(cat <<'EOF'
## Summary
- Eval env gate flipped to a closed allowlist (model keys only); unit-tested
- OpenAI strong-model entry in the model catalog, probed before pinning
- Routing allowlist + eval fixtures moved to real catalog ids, free-tier fallback
- scripts/run-evals-pr.sh: local serial eval runs, 429-retry, replaceable PR comment
- Two live evals from the Desirable Outputs benchmark: linear-draft proposal pattern, what-is-on-my-plate synthesis pattern

## Test plan
- [ ] pnpm vitest run tests/unit (gate + stub coverage)
- [ ] eve eval routing (fixture) passes
- [ ] Full eve eval suite passes serially
- [ ] Runner posts exactly one marked comment on this PR

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then run `scripts/run-evals-pr.sh` once to post the first results comment.

- [ ] **Step 6: Commit (nothing should remain; verify clean)**

Run: `git status --short`
Expected: empty output. If anything remains, commit it with a descriptive message before review.
