# agents

Owns: profiles, threads, messages, checkpoints, runs, steps, tool calls, questions, run events, memory

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
(agents/engineering.md). Enum values are the contract: add a value, never
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
`cancelled`. `/alfred` reloads with `listRecentRuns` plus `listThreads`, so the
browser holds no thread state. POST /runs/:id/messages signals Eve
(`POST /eve/v1/session/:id`) and answers 409 `run_finished` on a finished run;
POST /runs/:id/retry makes a new run id (`retry_of_run_id` set); POST
/runs/:id/cancel calls Eve cancel.
