# ADR 0006: Agent access control foundation and Eve orchestration

**Status:** PROPOSAL (owner questions 1-5 answered 2026-10-19; adapter work remains) — the foundation half is built and merged (recorded here
as as-built); everything under "Eve-dependent remainder" is a proposal
awaiting the owner decisions listed at the end.
**Date:** 2026-10-19
**Refs:** ASH-122 (GA01-GA12), ASH-115, ADR 0002, ADR 0004, RT02-04

## Owner decision recorded

On 2026-10-19 the owner answered ASH-115's responsibility half (verbatim):

> "Eve is the orchestrator for all agentic work that is supposed to happen in
> Polymath."

Settled: **Eve is the single orchestrator for all agentic work.** There is no
second runtime path to design for, and the Axiom-side foundation below is
built exactly once, with Eve as its only execution consumer.

**Not answered:** which runtime Eve runs in. Every proposal below that names
a runtime boundary carries that question mark. (The application is separately
being renamed Axiom → Polymath; this ADR keeps the existing naming for the
code it describes.)

## What is built (Axiom-side, all default-off)

Authority lives in Axiom, never in the runtime (ASH-122's core contract).
The foundation shipped as additive slices; guards.ts RANK remains the only
live enforcement surface and no existing behavior changes.

- **GA01 — agent principals** (`agent_principals`, migration 0170): the
  identity an agent run acts under. Not a person, not a membership, no role,
  no implicit authority. Every principal has an accountable human owner
  membership, so scheduled automation never runs as the last editor's
  ambient account. Revocation is a terminal kill switch.
- **GA02 — immutable bounded delegation grants** (`agent_delegation_grants`,
  migration 0171): the only path by which authority reaches a principal.
  Scoped (catalog operations, resources, account aliases, destinations,
  context boundary), expiring (7-day ceiling), frozen at issuance (DB
  trigger) with a sha256 content pin. Issuance is a human act by a
  membership, so an agent can never mint grants; an agent may receive only
  capabilities the delegator holds; `action.approve`, `role.define`,
  `role.assign`, and `ownership.transfer` are never delegable.
- **GA07 — attenuation**: child grants are strict subsets of their parent on
  every axis, exactly one depth deeper, capped at depth 3; a revoked or
  expired parent kills its chain.
- **GA03 — deterministic tool-authorization gateway** (`authorization.ts`):
  one pure function decides one invocation from the grant, the operation
  registry, and the invocation. Deny by default; profile visibility is not
  authorization; a grant whose stored content no longer matches its pinned
  hash is dead (confused-deputy tripwire). External effects authorize only
  as `requires_approval` pending GA06.
- **GA10 (evidence half) — decision log** (`agent_authorization_decisions`,
  migration 0172): every verdict, allow and deny, recorded immutably with
  the cited grant and full reasons. A denial's only effect is its log row.

## Eve-dependent remainder (PROPOSAL)

With Eve settled as the orchestrator, these packages become runtime-adapter
work rather than new Axiom subsystems. Proposed shape, per package:

- **GA03 (adapter boundary):** Eve's tools never call providers directly.
  Each invocation is admitted through `authorizeToolInvocation` (recomputing
  the grant hash from the stored row) and recorded via
  `decideAndRecordToolInvocation`; provider adapters accept approved gateway
  commands — operation, resolved target, redacted arguments, account alias —
  never arbitrary model-selected URLs or credentials. Direct runtime/provider
  bypass must fail closed, including when the policy read itself fails.
- **GA04 — authorized context:** run context binds a `context_manifest_id`
  carried on the grant; retrieval is filtered to the manifest before
  material reaches the model, memories partition by workspace and scope, and
  access changes invalidate reusable context. Limitation to record honestly:
  already-transmitted data cannot be recalled from a provider.
- **GA05 — accounts, secrets, egress:** the grant's `allowed_accounts`
  aliases bind exact integration accounts (no personal-for-work
  substitution); OAuth secrets never enter model context; destinations are
  checked against `allowed_destinations` on every outbound payload.
- **GA06 — exact-action approvals:** an approval binds workspace, grant,
  action revision, account, resolved target, canonical payload hash, and
  expiry; execution rechecks initiator/executor/approver authority and
  claims atomically; lost provider responses reconcile as UNKNOWN. Approval
  never expands delegator authority, and exactly-once is never promised
  across a provider boundary.
- **GA08 — revocation and fencing:** principal/grant revocation is checked
  at dispatch, tool admission, resume, approval execution, and output
  delivery; execution generations fence stale callbacks (RT02 contract);
  cancellation is not rollback — accepted external operations may complete
  and reconcile.
- **GA09 — budgets:** atomic reservations for cost/tool calls/concurrency/
  tokens, shared across fan-out; authorization stays independent of budget.
- **GA10 (console half):** the permissions console renders grants, verdicts,
  and why-allowed/denied from the decision log; configuring agents stays
  separate from running or approving them.
- **GA11 — adversarial evals:** prompt-injection, fake approvals, account
  swapping, stale grants, permission laundering, and revocation mid-flight
  against the fake runtime (RT02 contract suite), published as coverage and
  limitations, never an absolute safety claim.
- **GA12 — rollout:** shadow comparison behind the enforced baseline,
  read/prepare before consequential execution, deny-by-default rollback,
  incident drill (compromised tool, leaked grant, UNKNOWN provider outcome).

## Owner decision: Eve runtime (2026-10-19, iMessage)

Answer to open question 1 (owner, paraphrased from his message): Eve works
with Next.js. On Vercel it runs on the free Vercel platform; locally it runs
on the user's own computer.

Design consequences (proposal, to be built against the adapter boundary):

- **Two modes, one contract.** `hosted` (Vercel free tier, serverless
  functions) and `local` (same app on the user's machine). Same
  `AgentRuntime` port, same grants, same gateway; only the executor host
  differs. No separate always-on Eve service is assumed.
- **Vercel free-tier limits are a hard constraint.** A function invocation
  cannot be assumed to live longer than its plan limit, so no run may depend
  on a single long invocation. A run is a sequence of short steps; each step
  claims a lease on the canonical `jobs`/`attempts` rows (ASH-134 Q04:
  lease + generation fencing), does bounded work, checkpoints to run events,
  and either finishes or re-enqueues itself. A killed invocation is
  indistinguishable from a slow one until its lease expires, then another
  invocation resumes from the last checkpoint; the generation fence rejects a
  zombie's late writes.
- **Driving the steps.** Hosted: the outbox dispatch route (ASH-134 Q03) and
  Vercel cron, within free-tier cron and invocation quotas; no per-run
  polling loops. Local: an in-process loop over the same job table. Both call
  the same step function.
- **Unknown outcomes** (a step died after an external call) follow the
  existing attempt `unknown` + reconciliation rule; never blind retry.
- **Local mode** runs with the same Axiom authority checks: the local
  process authenticates as the signed-in user's workspace, grants and the
  decision log still apply, and external effects still need approval. Local
  mode must not widen authority because it is on the user's machine.
- **Open follow-ups:** concrete step time budget per mode, cron cadence that
  fits free-tier quotas, and where local mode keeps its database (Neon vs a
  local Postgres).

## Open questions for the owner

1. **ANSWERED 2026-10-19** (see "Owner decision: Eve runtime" above; follow-ups listed there). Was: which runtime does Eve run in? (ASH-115's unanswered half.) The
   adapter boundary above is runtime-agnostic, but GA06/GA08/GA09 need the
   concrete dispatch/callback/resume semantics to bind against.
2. **DECIDED 2026-10-19 (option a): catalog v2.** Grew the catalog with
   `task.read` and `knowledge.read`; `tasks.read` now maps to `task.read`.
   Catalog version is 2, additive.
3. **DECIDED 2026-10-19 (option a): grant lifetime.** Agent grants stay at
   7 days. Service-principal grants may live up to 30 days; renewal is a
   new grant issued by a human admin, which is the owner re-confirmation.
4. **DECIDED 2026-10-19 (option a): registry stays in code.** Adding a tool
   operation to `TOOL_OPERATION_REGISTRY` is a code review, never runtime data.
5. **DECIDED 2026-10-19 (option a): approvals.** The owner approves external
   writes and sensitive writes; an admin may approve internal preparation
   (`prepare`). Members can still reject. Enforced in `decideProposal`.
