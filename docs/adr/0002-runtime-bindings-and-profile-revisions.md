# 0002: Immutable profile revisions and runtime bindings (ASH-117, RT03)

Status: accepted (code, migration 0140).

## Ownership

`src/domains/agents/schema.ts` owns the agent runtime tables;
`src/domains/agents/runtime-bindings.ts` owns the commands that write them.
The actions domain (`src/domains/actions/schema.ts`) keeps its own
proposal/review/attempt/observation machine — no second approval universe was
added here.

## Immutable vs mutable

- `agent_profiles` stays **mutable**: it is the editable configuration.
- `agent_profile_revisions` is **append-only** (`recordedBy`, no `updatedAt`):
  the immutable copy of a profile exactly as admitted. Editing a profile
  writes the next `revision_number`; existing runs keep pointing at the
  revision they started with (`agent_runs.profile_revision_id`, `onDelete:
  restrict`). Runs started before revisions existed keep the coarser frozen
  `policy_snapshot` guarantee.
- `run_executions`, `run_signals`, `tool_calls` are **append-only** rows;
  lifecycle moves by updating the row's own state columns, never by rewriting
  identity fields (`generation`, `provider_execution_id`, `signal_key`,
  `invocation_id`, hashes).

## Identity and uniqueness

- Execution: unique `(run_id, generation)`; unique
  `(provider, environment, provider_execution_id)` where bound; unique
  `(workspace_id, dispatch_key)` for idempotent dispatch retries.
- Signal: unique `(run_id, generation, signal_key)`; the payload hash must
  match on replay or the write fails loudly.
- Tool invocation: unique `(workspace_id, invocation_id)` where present;
  replay compares the canonical argument hash (sorted keys, undefined
  dropped, sha256).

## Tenant integrity

New runtime tables carry composite foreign keys `(workspace_id, run_id)` →
`agent_runs(workspace_id, id)` (and the same shape for profiles), so a
cross-workspace reference is rejected by the constraint, not by convention.
`tool_calls` predates this pattern; its workspace scoping is enforced by
domain validation (`assertRunInWorkspace`) and tested.

## Uncertainty

`uncertain` (executions) and `unknown` (signals) are first-class states with
timestamps and reconciliation flags. A lost dispatch or delivery response is
never recorded as failure: the effect may exist, and only reconciliation
(provider observation) may close it. The partial indexes
(`run_executions_uncertain_idx`, `run_signals_pending_idx`) are what a sweep
reads.

## Retention and secrets

Rows live with their run (`onDelete: cascade` from `agent_runs`); nothing
here has an independent retention policy yet. Arguments, results, and signal
payloads are stored redacted — never secrets, raw provider payloads, or
hidden chain-of-thought.

## Historical imports

No historical run or action rows are backfilled or dispatched: legacy
`tool_calls` rows keep `invocation_id = null` and stay outside the new
uniqueness rules.
