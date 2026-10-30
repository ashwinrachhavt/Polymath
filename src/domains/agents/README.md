# agents

Owns: profiles, threads, messages, checkpoints, runs, steps, tool calls, questions, run events, memory

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across domains
. Enum values are the contract: add a value, never
repurpose one.

Eve tools resolve their run UUID and frozen policy through the persisted
session_ref plus authenticated workspace. Missing, ambiguous, or terminal
bindings fail closed; tasks.read returns bounded canonical open tasks.

## Signed-in run start

The app authenticates the caller (Clerk), resolves their workspace, and mints a
60-second HMAC bridge token (`bridge-token.ts`, `EVE_BRIDGE_SECRET`, 32+ chars,
the same value for the app and the Eve agent). The Eve channel verifies the
signature, then re-checks the active membership and role in the database
(`verifyWorkspaceBinding`) before it puts the workspace id in the session
attributes. The old `x-spike-clerk-user-id` header is gone. Without the secret,
POST /api/v1/runs returns 503 `agent_bridge_unavailable` and reserves nothing.

POST /api/v1/runs accepts an `Idempotency-Key` (UUID). The receipt is claimed
before the engine runs: the same key returns the first run, a different body is
422, an in-flight key is 409, and a failed start frees the key. The Eve
`operationId` is `axiom-run-<runId>`, so Eve's create is also once-only. The
Eve session id lives in `agent_runs.session_ref`. GET /api/v1/runs/:runId
returns 404 for a run in another workspace. Retrieval, signal/resume and
terminal lifecycle handling are later work.

## Thread survives refresh

A run's thread is its `run_events`. The engine writes the objective as the
first `message` event before the Eve session starts; the Eve hook appends each
assistant reply; a follow-up appends a user `message`; cancel appends
`cancelled`. `/polymath` reloads with `listRecentRuns` plus `listThreads`, so the
browser holds no thread state. POST /runs/:id/messages signals Eve
(`POST /eve/v1/session/:id`) and answers 409 `run_finished` on a finished run;
POST /runs/:id/retry makes a new run id (`retry_of_run_id` set); POST
/runs/:id/cancel calls Eve cancel.

## Runtime persistence (ASH-117, migration 0150)

Refines the existing agent schema (ASH-105); no parallel agent database. Reused
as-is: `agent_runs` (state, `policy_snapshot`, `session_ref`), `run_events`,
`agent_steps`, `tool_calls`, `agent_questions`, `run_artifacts`, `threads`.

Added (`runtime-schema.ts`, helpers in `runtime-persistence.ts`):

| Table | Identity (unique) | Immutable | Mutable |
| --- | --- | --- | --- |
| `agent_profile_revisions` | (profile, revision), (profile, content_hash) | every column (trigger) | none |
| `runtime_executions` | (run, generation), (workspace, dispatch_key), (workspace, provider, environment, provider_execution_id) when bound | run, generation, provider, environment, workflow_version, dispatch_key; provider id once bound | dispatch_state, timestamps, redacted_error |
| `runtime_signals` | (execution, signal_key) | execution, key, payload revision and hash | status, attempts, reconcile fields |
| `tool_invocations` | (run, invocation_id) | run, invocation id, tool, arguments hash, effect class; terminal state | state, redacted result, timestamps |

`agent_runs.profile_revision_id` pins the revision at admission (NULL for runs
that predate it); with `policy_snapshot` and `agent_profile_id` it cannot change
afterwards. Editing a profile only makes a new revision.

Dispatch states: `planned`, `dispatching` (intent recorded, call may have left),
`dispatched` (provider id bound), `unknown` (needs reconciliation, never
treated as failed or succeeded), `rejected`, `completed`, `failed`. Tool
invocations use `requested`, `in_flight`, `succeeded`, `failed`, `unknown`;
reusing an invocation id with different arguments throws
`invocation_arguments_mismatch`, and an existing identity is replayed from its
stored state rather than run again.

Isolation: new tables reference parents through composite
`(workspace_id, id)` foreign keys, so a cross-workspace reference is a
constraint error. The same keys were added to the existing run/thread/profile/
run_artifacts references as `NOT VALID` (new and changed rows are enforced;
`VALIDATE CONSTRAINT` is an operational step once data is confirmed clean).

Retention: all rows cascade with the workspace. Only redacted arguments/results
are stored (`redactForStorage`); hashes fingerprint the unredacted request.
No secrets, no chain-of-thought. Historical runs/actions are not backfilled or
dispatched. Applying this migration to production needs separate authorization.
