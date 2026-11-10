# superagent

The agent architecture that supervises work instead of only reacting to it:
immutable Triggers, a policy gate and an Assessment before anything starts,
Tickets carrying frozen Mandates, durable effects, and honest reporting.
Ported from the dsh-superagent-prototype's concepts and rules; adapted to
Polymath's host (eve, Drizzle, the audit outbox, Clerk workspaces).

## What this domain owns

- **The pipeline.** A person's chat message becomes a Trigger (translated by
  the chat Source plugin, stable id, own messages dropped). The policy gate
  admits it (explicit immediately; inferred only with enabled rules and the
  configured accept mode). An Assessment judges the candidate — one eve eval
  session with bounded context — and an accepted assessment opens a **Ticket**
  whose Mandate is frozen at admission (strength, basis, scope, policy
  version). Execution runs as **TicketRuns** on eve; replies and reports flow
  back through outbox receipts into the same chat thread.
- **The engine.** `core/` — the sole writer of domain state. Five parts
  (Intake, Evals, Tickets, Runs, Replies), one transaction per command, the
  stage table as the panel's vocabulary, reason codes for every non-admission.
  Pure: no I/O, no eve, no database. In-memory repositories power the unit
  specs.
- **The store.** `store/` — the repositories over Drizzle and Postgres.
  Write-behind caches per aggregate: `save` marks dirty, `flush()` persists
  the transaction (every wiring command ends in one flush — "one command, one
  transaction" is enforced at that boundary, not by SQL). Generated columns
  (`is_active`, `needs_attention`) keep passes on active work. Owns
  `work_*` and `superagent_state` tables and its own migration series.
- **Effects.** `effects/` — the durable queue (`work_effects`): one row per
  (kind, key), claim/complete/fail with leases, backoff 2s→60s (reply 5s→300s),
  a `Later` throw defers without counting a failure, a health entry after
  three consecutive failures. The engine enqueues inside the command's
  transaction; handlers run only after the flush.
- **Policy.** `core/policy/` — the gate, the admission matrix, accept modes,
  revalidation per basis. The frozen revision is one hash over the rules, the
  accept mode, and the source parts (`policyVersion(config)`) — strength and
  accept mode ride the snapshot, no parallel table. A version change discards
  running assessments and requeues their triggers; live mandates stay.
- **Assessor.** `assessor/` — the admission judge. One dedicated eve profile,
  bounded context, expiry after two requeues then unavailable. Since the
  Mercury directive: the Eve judgment AND a Mercury Decide call run together;
  the Assessment records both and which path decided. Below-threshold
  probabilities and material disagreement take the escalate path. Decide
  lives behind the port — the engine stays deterministic.
- **Decide.** `decide/` — the Mercury Decisions client. `POST /v1/decisions`
  is NOT chat-completions shaped: typed questions over a state object, typed
  calibrated answers. Revalidation stays deterministic (rules, no model call).
- **Sources.** `sources/` — the SourceKind protocol and the chat plugin.
  v1 scope: the Polymath chat surface only. Proactive admission ships off.
- **Executor.** `executor/` — the ticket executor over eve runs. Start,
  deliver, and stop enqueue effects only. Worker slots cap concurrency with
  one spare slot a person's message can always use. Restart recovery reports
  interrupted runs oldest-first with a check-before-repeat note.
- **The panel.** `src/components/superagent` — Overview (what needs a person
  now), Tickets with drill-down, Settings.

## What stays on eve

Nothing here replaces the eve runtime. Sessions, streaming, tool calls,
spend, cancel — all eve, always behind the seams (`executor/eve.ts`,
`assessor/eve.ts`). One eve run per TicketRun, one eval session per
Assessment. The reactive run path (`POST /api/v1/runs`) still exists for the
other call sites; only the main chat send path goes through this domain in
v1.

## Naming

| Concept                                          | Here                        | Table                  |
| ------------------------------------------------ | --------------------------- | ---------------------- |
| Trigger                                          | Trigger                     | `work_triggers`        |
| WorkThread (work context, not a chat transcript) | WorkThread                  | `work_threads`         |
| Assessment (the prototype's Eval)                | Assessment                  | `work_assessments`     |
| Mandate                                          | Mandate (column on tickets) | `work_tickets.mandate` |
| Ticket                                           | Ticket                      | `work_tickets`         |
| TicketRun (the prototype's Assignment)           | TicketRun                   | `ticket_runs`          |
| Subscription                                     | Subscription                | `work_subscriptions`   |
| Policy                                           | Policy (settings-versioned) | `superagent_policy*`   |
| Effect                                           | Effect                      | `work_effects`         |
| Outbox receipt                                   | Outbox receipt              | `work_outbox_receipts` |

No table or export reuses a name from the agents schema. "Thread" in this
domain's text always means WorkThread; a chat transcript stays a
conversation — the sessionless eve run the chat surface streams.

## How the wiring runs it

`wiring.ts` composes the real host per workspace: the Drizzle store, the
policy from the stored document, the chat Source registry, the eve seams for
assessor and executor, and the engine over them. Three drain triggers move
effects:

1. **Inline after commit.** The legacy sessionless-chat continuation path ticks
   the engine and chains bounded dispatch passes after a follow-up is stored.
   New Polymath chat starts an interactive Eve run directly.
2. **The dispatch endpoint.** `POST /api/internal/outbox` (bearer-guarded)
   sweeps then drains — the operator's lever when inline work is cold.
3. **Cron recovery.** The existing cron route sweeps (tick + the ticket-run
   observer) and drains; on the free plan it is daily, which is why the
   inline drain is the primary trigger.

The prototype ticked every two seconds in-process; `engine.evaluateDue()` is
that tick, run at serverless granularity by every drain and dispatch pass.

## Invariants worth restating

- One writer (the engine), one transaction per command, external work enqueued
  inside and run only after commit.
- Receipts are claimed before work and completed after; the queue never queues
  an id twice; per-ticket, per-conversation order holds.
- `meta` on a Trigger is untrusted; revalidation may use only stored policy.
- Reports are honest: ready means ready, blocked means blocked, a draft says
  unfinished. Blocked and failed tickets take no automatic input — a person's
  message releases them.
