# Acceptance-gate release work — plan

**Spec:** `docs/axiom-product-spec.md` (canonical); ledger `ASH-180` in Linear
(project Axiom). The ledger's decisions and gate list are the binding contract
for this plan.

**Goal:** make the six release-gate checks in ASH-180 verifiable from code and
tests, then hand the human-only checks (hosted run, external participant,
document corpus) to their owners with their acceptance criteria written down.

**Branch:** `ashwinr/acceptance-gates` off `ashwinr/inbox-enrich`.

## Global constraints

- `make check` (lint, typecheck, test, build) passes.
- Invariant tests run against real Postgres (`TEST_DATABASE_URL`), never mocks.
- No new dependency. No new feature flag system.
- A capability that is switched off must say so — never render an empty success.
- Diff minimal; every added file has a caller.

## Already landed before this plan (do not rebuild)

Commit `wip`: ASH-193 capability registry + settings panel; ASH-189 `vercel.json`
cron + GET entry point; ASH-191 `resolveUnknownSend`; tests for 191 and 189.

Verified coverage that already exists:
- Gate 4 (cancel releases reservation): `tests/integration/policy.test.ts:169`.
- Gate 3 (unknown send blocked + now resolvable): `tests/integration/send-executor.test.ts`.
- Gate 5 (not-configured states): `tests/unit/capability-config.test.ts`.

## Tasks

### Task 1: Idempotency replay (Gate 2)

**Files:** `tests/integration/receipt.test.ts` (new).

`src/domains/audit/receipt.ts` implements `withReceipt` but has **no test**.
Gate 2 asks for proof that replaying a mutation produces no second external
effect. Write that test against real Postgres.

Cases, all through the public `withReceipt` interface:
1. Same key + same request runs `run` once and replays the stored value
   (`replayed: true`), with the side effect occurring exactly once.
2. Same key + different request throws `IdempotencyConflictError`.
3. No key runs each time (no receipt stored).
4. Concurrent first attempts with one key: exactly one executes `run`.
5. A different workspace with the same key string is independent.

**Acceptance:** the new suite passes against real Postgres and fails if the
replay branch is removed.

### Task 2: Gate status in the ledger

**Files:** Linear ASH-180, ASH-189, ASH-190, ASH-191, ASH-192, ASH-193 only.

Mark which gate checks now have a code-level proof, with the test path, and
which remain human-only (ASH-194, 195, 196, 197).

## Human-only — not implementable here

ASH-194 (external participant runs the script), ASH-195 (score 10 real
documents), ASH-196 (live calendar read), ASH-197 (choose the participant).
These need a person and live credentials; a subagent cannot produce their
evidence, and fabricating it would defeat the release's whole premise.
