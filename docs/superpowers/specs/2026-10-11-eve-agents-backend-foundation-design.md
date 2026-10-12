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
- **Mounts into an existing Next.js app** via `withEve()` at `/eve/agents/<name>`.
- **Evals.** `evaluate` (AI SDK evaluation API) for typed questions; tool-approval
  classifiers (`auto()` with custom instructions/criteria) for policy behavior.

## Decision

**Eve-native, Neon-mirrored.** Eve runs the durable conversation loop inside Axiom's
Next.js app. Axiom's Neon tables stay the system of record for the UI: run timelines,
tool calls, spend, approvals, and memory are mirrored from eve's event stream into
`agent_runs`, `run_events`, `tool_calls`, `agent_questions`, and `memory_items`. No
duplicate task/artifact/approval universes. Axiom's `AgentEngine` contract is the only
seam domain code sees; domain code never imports `eve` directly, so the framework can
be swapped behind one adapter.

Rejected: `@workflow/world-postgres` for session state (protocol lock against eve's
vendored `@workflow/*` line for no gain — Vercel's dashboard covers loop state), and a
sidecar eve service (violates the consolidation decision).

## Architecture

```text
Browser → Next.js app
  ├─ App Router UI: Reviews, Activity, Alfred run timeline (RSC, reads Neon)
  ├─ /eve/agents/<name>  ← withEve() mount: Alfred root + research/studio/ops subagents
  ├─ EveAgentEngine (starts/signals sessions; wraps eve; the one eve import point)
  ├─ Event bridge (eve hooks → agent_runs/run_events/tool_calls/agent_questions)
  ├─ Domain modules (work, capture, crm, agents, spending, actions)
  └─ Neon Postgres + pgvector (system of record)
```

One run = one addressed eve session. Axiom generates the delegation session id and
keeps it in `agent_runs`; the event bridge keeps the mirror current.

## Work order

### Phase A — Auth and Clerk (built first, protects everything)

1. **`src/lib/auth.ts`** — `getAuthContext(): Promise<AuthContext>` where
   `AuthContext = { userId, workspaceId, role }`:
   - Clerk `auth()` → `clerkUserId` → upsert `users` row (first sign-in creates it).
   - Resolve active `memberships`. Single workspace per user in v1: first active
     membership, else auto-provision a personal workspace + owner membership.
   - Wrapped in React `cache()` so parallel server components share one resolution;
     one Neon round trip per request.
   - `getAuthContext` resolves identity through domain-owned queries; `lib` itself
     treats identity as its allowed dependency edge, consistent with the plan's
     `lib/auth` placement (engineering.md's "`lib` imports nothing from `domains`"
     is honored by keeping the Clerk→user→membership resolution in
     `src/domains/identity/` and calling it from `lib/auth.ts`).
   - One Neon round trip per request, cached per request via React `cache()`.
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
7. **Event bridge (`src/workflows/event-bridge.ts`)** — eve instrumentation maps
   session/step/tool events into `run_events` (monotonic per-run sequence, the SSE
   cursor), redacted `tool_calls`, `agent_questions` on HITL questions, and state
   transitions on `agent_runs`. Axiom run timeline reload reconstructs from these rows.
8. **Spending commands (`src/domains/spending/`)** — reserve before session start
   against the frozen budget (`spending_reservations`), settle on terminal event,
   release on cancel. Ceiling holds under concurrency: the reservation row is the claim.
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
  budget-race tests above.
- **E2E (Playwright)** adjusts when the Alfred chat UI lands; this foundation is
  backend-only and covered by the layers above.

## Out of scope (later issues)

A02 profile revisions/compile ceilings, A03 context manifests, A07 handoffs, A09
ActionExecutor, A22 run UI. The foundation creates the seams for each; none are built
here. Deprecated: nothing in the current schema is retired by this design.
