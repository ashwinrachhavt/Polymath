# Eve Agents Backend Foundation — Design

**Status:** Approved (conversational design, 2026-10-11)
**Parent:** [ASH-112](https://linear.app/ashwinr/issue/ASH-112) — bounded multi-agent architecture
**Supersedes:** the "Eve is unknown" discovery blocker in `docs/axiom-nextjs-neon-plan.md`

## What Eve is

Eve is Vercel's open framework for building agents (github.com/vercel/eve, npm `eve`,
Apache-2.0, beta). Facts that shape this design, verified against eve.dev today:

- **Agents are filesystem directories.** `agent/instructions.md` (system prompt),
  `agent/agent.ts` (model config), `agent/tools/*.ts` (typed tools with Zod schemas),
  `agent/subagents/<id>/` (specialists with their own tools, sandbox, and instructions),
  `agent/skills/` (procedures loaded on demand).
- **Durable sessions.** Every session is one durable workflow (Vercel Workflow on
  Vercel, local world in dev). Work nests as session → turn → step; steps checkpoint;
  a crashed process resumes from the last completed step. Completed steps never re-run.
- **HITL is built into tools.** `approval: always() | auto() | never() | policy` parks
  the run durably at `session.waiting` for a person. Policies receive session auth and
  can deny, auto-approve, or require user approval per call.
- **Subagents.** Root agent delegates via the built-in `agent` tool or declared
  subagents under `agent/subagents/` with their own tool surfaces. Delegation transfers
  data through the message input only; children don't see parent history.
- **Mounts into an existing Next.js app** via `withEve()` (eve@0.77.0, verified in
  `dist/src/public/next/index.d.ts`): a **next.config.ts wrapper**, not a runtime
  export. It proxies eve protocol endpoints to an eve service — `eve dev --no-ui`
  locally, Build Output service routes on Vercel prod — and named agents mount at
  **`/eve/<name>/v1/*`**. Eve requires Node 24+.
- **Evals.** `evaluate` (AI SDK evaluation API) for typed questions; tool-approval
  classifiers (`auto()` with custom instructions/criteria) for policy behavior.

## Decision

**Eve-native, Neon-mirrored.** Eve runs the durable conversation loop inside Axiom's
Next.js app. Axiom's Neon tables stay the system of record for the UI: run timelines,
tool calls, spend, approvals, and memory are mirrored from eve's event stream into
`agent_runs`, `run_events`, `tool_calls`, `agent_questions`, and `memory_items`. No
duplicate task/artifact/approval universes. Axiom's `AgentEngine` contract is the only
seam domain code sees; domain code never imports `eve` directly. The seam is real at the engine boundary;
tools, agents, and evals are eve-file-authored, so the framework choice is a
**strategic lock to eve** (a beta) owned by this spec — revisit if eve stalls.

Rejected: `@workflow/world-postgres` for session state (protocol lock against eve's
vendored `@workflow/*` line for no gain — Vercel's dashboard covers loop state), and a
long-running sidecar eve service process (violates the consolidation decision). Note:
`withEve()` itself starts a local `eve dev` service in development — that is the
framework's own dev tooling, not an Axiom-managed sidecar. Event bridge lives in
`src/domains/agents/` (D1, decided 2026-10-11): one file does not justify moving
`src/workflows/` (the empty directory from the plan layout, already present); non-agent
durable workflow definitions land there when they arrive.

## Architecture

```text
Browser → Next.js app
  ├─ App Router UI: Reviews, Activity, Alfred run timeline (RSC, reads Neon)
  ├─ /eve/<name>/v1/*  ← withEve() proxy: Alfred root + research/studio/ops subagents
  ├─ EveAgentEngine (starts/signals sessions; wraps eve; the one eve import point)
  ├─ Event bridge in src/domains/agents/event-bridge.ts (eve hooks → run tables)
  ├─ Domain modules (work, capture, crm, agents, spending, actions)
  └─ Neon Postgres + pgvector (system of record)
```

One run = one addressed eve session. Axiom generates the delegation session id and
keeps it in `agent_runs`; the event bridge keeps the mirror current.

## Work order

### Phase 0 — Spike (gates Phase B)

0. **Spike: eve hello-world inside this app** — install `eve@latest`, `ai`, `zod`;
   declare `engines.node >=24`; wrap `next.config.ts` with `withEve()`; mount one
   hello-world agent reading a stub domain query; run `eve dev --no-ui`; get one real
   event through the hook pipeline into `run_events`; confirm the Clerk auth extension
   point (custom policy resolving `AuthContext`, frozen snapshot per session). Output:
   verified `withEve()`/hook/auth API shapes or the plan is revised before Phase B.
   Spike code is throwaway; the verified API shapes are the deliverable. (D2,
   decided 2026-10-11.)

### Phase A — Auth and Clerk (built first, protects everything)

1. **`src/lib/auth.ts`** — `getAuthContext(): Promise<AuthContext>` where
   `AuthContext = { userId, workspaceId, role }`:
   - Clerk `auth()` → `clerkUserId` → upsert `users` row (first sign-in creates it).
   - Resolve active `memberships`. Single workspace per user in v1: first active
     membership, else auto-provision a personal workspace + owner membership.
   - Wrapped in React `cache()` so parallel server components share one resolution;
     one Neon round trip per request.
   - `getAuthContext` resolves identity through domain-owned queries; the Clerk→
     user→membership resolution lives in `src/domains/identity/` and is called
     from `lib/auth.ts`.
2. **Server Action guard** — `withAuth(fn)` in `src/lib/auth.ts`. Every server action
   begins `withAuth(async (auth, input) => ...)`. Unauthenticated → typed
   `UnauthorizedError` → problem+json. One line per action; cannot be forgotten.
3. **Route Handler guard** — `requireAuthContext(request)` for `/api/v1/**`: 401
   problem+json with stable code when no Clerk session. `/api/webhooks/**` exempt
   (HMAC signature is their auth, per the security contract).
4. **Eve mount auth** — the `withEve()` channel authentication policy resolves the
   Clerk session; delegated work carries the frozen `AuthContext` snapshot taken at
   session start. Live credentials never cross the boundary.
5. **Workspace scoping** — every domain query filters `workspace_id = auth.workspaceId`.
   No client ever supplies an owner id.

### Phase B — Agent engine and runtime

6. **`src/domains/agents/engine.ts`** — the `AgentEngine` contract from the plan:
   `start(input): {runId}`, `signal(runId, signal)`, `cancel(runId, actor)`,
   `resume(runId)`. First implementation `EveAgentEngine`, backed by eve sessions.
   Run row created before the session starts; policy snapshot (profile, model, tools,
   budget, auth) frozen at start.
7. **Event bridge (`src/domains/agents/event-bridge.ts`)** — eve instrumentation maps
   session/step/tool events into `run_events` (monotonic per-run sequence, the SSE
   cursor), redacted `tool_calls`, `agent_questions` on HITL questions, and state
   transitions on `agent_runs`. Also mirrors session messages into `threads`/`messages`
   with `runId` populated (D4, decided 2026-10-11) — the Alfred chat UI reads these.
   **Idempotency (D3, decided 2026-10-11):** sequence numbers are assigned in one Neon
   transaction keyed on the `(runId, sequence)` conflict target, so workflow retries
   and resumed steps that re-fire hooks dedupe instead of double-writing. Axiom run
   timeline reload reconstructs from these rows.
8. **Spending commands (`src/domains/spending/`)** — reserve before session start
   against the frozen budget (`spending_reservations`), settle on terminal event,
   release on cancel. **Settlement (D3, decided 2026-10-11):** token usage arrives in
   usage events mid-run; the bridge accumulates per-run usage and the terminal event
   closes the reservation with the accumulated amount. **Concurrency (D3):** the
   ceiling claim serializes via a Postgres advisory lock per workspace taken before
   the reservation insert, so two concurrent `start()` calls cannot both spend the
   last dollar. Release on cancel happens before the lock is held across any wait —
   reserve/settle are short transactions.
9. **Tool layer (`agent/tools/`)** — domain read tools call Axiom queries with the run's
   frozen `AuthContext`. Direct external writes never exist: tools either gate through
   eve approval (`always()`/`auto()` with Axiom policy text) or append a proposal to
   `action_proposals` for Reviews and the later ActionExecutor (A09).

### Phase C — Evals

10. **Policy evals (Vitest, real Neon)** — the ASH-112 acceptance tests: replay
    (re-run proposal → no duplicate effect), tenancy/source leakage (cross-workspace
    read denied), delegated escalation (child grant cannot exceed parent's approved
    intent and source scope), stale workers (session handoff with pending work fails
    over safely), revocation (killed session stops at the next boundary), concurrent
    budget and approval races (two runs cannot both spend the last dollar; approving
    one of several pending prompts does not authorize the others).
11. **Routing/classifier evals (eve harness)** — `evaluate()` for model routing
    choices; `auto()` with Axiom policy text as the approval classifier. Evals start
    with the first policy implementation, per the acceptance criteria.

## Schema

No new tables required for this foundation. Phase B fills
`spending_reservations`/`spend_settlements` commands, and the profile-seeding
(upserting `agent/instructions.md` into `agent_profiles`) reuses existing columns.
Profile revisions (A02) and handoffs (A07) extend `agent_profiles`/`agent_runs` in a
later migration when the first specialist profile lands — spine says: schema shaped for
many, shipped for one.

## Agent profiles (v1 set)

- **Alfred** (root): routes and converses; subjects = threads; tools = domain reads,
  delegation only.
- **research**: source investigation via Firecrawl, bounded by the parent's approved
  intent and source scope; produces cited evidence.
- **studio**: drafts artifacts/patches for review; no external access.
- **ops**: prepares external action proposals; never executes; executor work belongs
  to A09's deterministic executor, not to the profile.

Handoffs between profiles stay bounded: a child's grants never expand the approved
user intent (A07's server-issued delegation authority, built when the first handoff
journey lands).

## Testing

- **Unit (Vitest)**: auth resolution (unauthenticated, no-membership,
  auto-provision), engine contract (start/signal/cancel/resume state transitions),
  event-bridge mapping (event → row shape, sequence monotonicity, redaction).
- **Integration (real Neon)**: the ASH-112 acceptance tenancy/replay/escalation/
  budget-race tests above; plus bridge idempotency under a resumed step's re-fired
  hooks (duplicate `(runId, sequence)` insert is a no-op) and settlement accumulating
  from mid-run usage events.
- **E2E (Playwright)** adjusts when the Alfred chat UI lands; this foundation is
  backend-only and covered by the layers above.

## Out of scope (later issues)

A02 profile revisions/compile ceilings, A03 context manifests, A07 handoffs, A09
ActionExecutor, A22 run UI. The foundation creates the seams for each; none are built
here. Deprecated: nothing in the current schema is retired by this design.

## Scope record (eng review, 2026-10-11)

feature answers: no cuts proposed, feature list retained; structure: Smaller arrangement (D1, event bridge in src/domains/agents/); outside review (native Claude fallback; Codex unavailable, `AUTH_FAILED`): 8 findings resolved as — D2 add Phase 0 spike (gates Phase B); D3 apply bridge idempotency (transactional sequence claim), settlement accounting (usage events accumulate, terminal closes), budget serialization (per-workspace advisory lock); D4 bridge mirrors session messages into `threads`/`messages`; D5 swap claim reframed as a strategic engine-boundary lock (tools/agents/evals are eve-file-authored); factual corrections: `withEve()` is a next.config wrapper (verified at eve@0.77.0 `dist/src/public/next/index.d.ts:125`), mount path `/eve/<name>/v1/*`, `src/workflows/` already exists empty; accepted scope: spec updated in place (D1 edits above); pending remedies: none.

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~1d / CC: ~45min)** — Phase 0 spike — install eve + mount hello-world agent via withEve()
  - Surfaced by: Outside Voice #1/#4 — integration unvalidated; auth extension point assumed
  - Files: `package.json`, `next.config.ts`, `eve/alfred/` (throwaway spike)
  - Verify: `eve dev --no-ui` yields one real hook event into `run_events`; Clerk policy resolves AuthContext
- [ ] **T2 (P1, human: ~3h / CC: ~20min)** — `src/lib/auth.ts` — getAuthContext, withAuth, requireAuthContext
  - Surfaced by: Architecture Review — no auth code exists yet; Clerk→user→membership resolution lives in `src/domains/identity/`
  - Files: `src/lib/auth.ts`, `src/domains/identity/`
  - Verify: unit tests (unauthenticated, no-membership, auto-provision); 401 problem+json on `/api/v1/**`
- [ ] **T3 (P1, human: ~1d / CC: ~1h)** — `src/domains/agents/` — EveAgentEngine behind AgentEngine contract + event bridge
  - Surfaced by: Outside Voice #2/#6 — threads/messages unwired; bridge idempotency under retries
  - Files: `src/domains/agents/engine.ts`, `src/domains/agents/event-bridge.ts`
  - Verify: integration test — duplicate `(runId, sequence)` insert dedupes; `messages.runId` populated
- [ ] **T4 (P1, human: ~3h / CC: ~30min)** — `src/domains/spending/` — reserve/settle/release with advisory lock
  - Surfaced by: Outside Voice #5/#7 — budget concurrency; settlement from mid-run usage events
  - Files: `src/domains/spending/commands.ts`
  - Verify: integration test — two concurrent reservations race the last dollar, one wins
- [ ] **T5 (P2, human: ~4h / CC: ~40min)** — `agent/tools/` — domain read tools + approval-gated external proposals
  - Surfaced by: Decision — external writes become `action_proposals`, never direct calls (A09 executor later)
  - Files: `agent/tools/`, `src/domains/actions/`
  - Verify: unit test — external write attempt produces a proposal row, no provider call
- [ ] **T6 (P2, human: ~1d / CC: ~45min)** — policy evals (Vitest, real Neon)
  - Surfaced by: Phase C / ASH-112 acceptance — replay, tenancy, escalation, stale workers, revocation, races
  - Files: `tests/integration/`;
  - Verify: `pnpm vitest tests/integration` against Neon branch
- [ ] **T7 (P3, human: ~4h / CC: ~20min)** — routing/classifier evals (eve harness)
  - Surfaced by: Phase C item 11 — `evaluate()` + `auto()` with Axiom policy text
  - Files: `eve/alfred/evals/`
  - Verify: eve eval run produces pass/fail report

_Gates: T1 (Phase 0 spike) blocks T3–T5; T2 blocks everything._

_Suppressed findings: none — all 8 outside-voice findings were resolved or folded into D2–D5._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Outside Review | codex-plan-review (native Claude fallback) | Independent 2nd opinion | 1 | unavailable | 8 findings (Codex `AUTH_FAILED`; native fallback verified against repo/npm) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_open | 5 issues, 0 critical gaps (prior 2026-10-10 run: 13 issues) |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**OUTSIDE COVERAGE:** codex (codex-plan-review) unavailable — `AUTH_FAILED` (codex-cli 0.162.1, not logged in). Native Claude subagent fallback completed: 8 findings, verified against repo and npm evidence, resolved as D2–D5. External coverage not established.

**VERDICT:** ENG review not CLEAR — issues_open (mapped to T1–T7, pending Phase 0 spike). eng review required. NO UNRESOLVED DECISIONS
