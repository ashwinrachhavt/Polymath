# superagent

Owns: the supervised agent layer — Triggers, WorkThreads, Assessments, Tickets,
TicketRuns, Subscriptions, the Engine and its five parts, the stage table, and
reason codes.

## What lives here

`core/` is the pure domain, ported from the
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)
core (`src/core`): model types, ports, the Engine with its five parts
(Intake, Evals, Tickets, Runs, Replies), the first-match-wins stage table
(`stage.ts`), reason codes (`reasons.ts`), and in-memory repositories
(`memory-repository.ts`) that make the engine specs fast and deterministic.

**Pure domain only**: no I/O, no eve imports, no database, no Next. External
work (an eve run, a channel send) is expressed as ports (`Assessor`,
`Executor`, `Outbox`) that the Engine calls; the store, effects, policy,
assessor, sources, and executor modules planned beside this core implement
those ports over Drizzle, the outbox, and eve. The Engine is the sole writer
of domain state; every command is one transaction; receipts are claimed
before work and completed after.

## Naming: the two-vocabularies rule

This domain ports the prototype's concepts under Polymath names. The
locked renames (spec §4) exist because several blueprint names are already
taken and load-bearing elsewhere in the codebase:

| Blueprint (prototype) | In Polymath                 | Home                    |
| --------------------- | --------------------------- | ----------------------- |
| Source                | Source (protocol)           | `sources/`              |
| Thread                | **WorkThread**              | `core/model.ts`         |
| Eval                  | **Assessment**              | `core/model.ts`         |
| Assignment            | **TicketRun**               | `core/model.ts`         |
| Ticket                | Ticket                      | `core/model.ts`         |
| Mandate               | Mandate                     | `core/model.ts`         |
| Trigger               | Trigger                     | `core/model.ts`         |
| Subscription          | Subscription                | `core/model.ts`         |
| Policy                | Policy (settings-versioned) | `policy/` (later wave)  |
| Effect                | Effect                      | `effects/` (later wave) |
| Outbound receipt      | Outbox receipt              | `effects/` (later wave) |

> **`threads` vs `WorkThreads`.** `agents.threads` groups chat transcripts
> around runs (`src/domains/agents/schema.ts`); a `WorkThread` here is a work
> context the domain groups Tickets and Subscriptions under. They are
> different concepts with the same name — never merge them, and never name a
> superagent table or export `thread*` where the agents schema already owns
> the word. The same caution applies to `Source`, `Channel`, `Assignment`,
> and `Eval`, which the migration map (research §7.1) marked as taken.

## Modules

- `model.ts` — domain types and the pure helpers over them (`liveTicket`,
  `runningTicketRun`, `ticketOutcome`, `followupOwners`, `reached`,
  `waitsForPerson`).
- `sources/` — the Source protocol (`kind.ts`), the host seams the store,
  effects, and cutover wiring implement (`host.ts`), the registry that adapts
  registered kinds to the Engine's `SourceScope` port (`registry.ts`), and the
  chat plugin (`chat.ts`): the Polymath chat surface as intake — stable
  trigger ids from the message's stream identity, the agent's own messages
  dropped, the read position advanced only after every covered trigger was
  stored, and the channel defined over the existing ChatFrame stream
- `ports.ts` — the seams: `Policy`, `Assessor`, `Executor`, `Outbox`,
  `Repositories`, and the source-scope protocol. No implementation.
- `ids.ts` — deterministic, idempotent keys (`key(...)`) hashed with
  SHA-256, so the same source event always yields the same id.
- `policy/` — the pure `Policy` port implementation over plain config:
  the admission table (`policy/admission.ts`), and the gate, accept
  modes, version hash, and mandate revalidation (`policy/gate.ts`).
  Host settings validation and persistence arrive with the settings
  module, which hands a validated `PolicyConfig` here.
- `errors.ts` — the `UserError` catalog; every refusal a caller can hit has
  one named code.
- `reasons.ts` — reason codes and their display text for decisions, ends,
  and gates.
- `stage.ts` — the panel's vocabulary: the first-matching-row stage table
  (`ticketStage`) and `canRetry`.
- `engine-parts.ts` — the `EngineOptions` wiring and the `EnginePart` base.
- `intake.ts`, `evals.ts`, `tickets.ts`, `runs.ts`, `replies.ts` — the five
  parts. `runs.ts` is the prototype's Assignments part renamed.
- `engine.ts` — `Engine`, `createEngine`, and the role-scoped `Pick` types
  (`EngineForSources`, `EngineForMainSession`, `EngineForPeople`,
  `EngineForSettings`).
- `memory-repository.ts` — in-memory `Repositories` for tests.
- `sources/` — the Source protocol (`kind.ts`), the host seams the store,
  effects, and cutover wiring implement (`host.ts`), the registry that adapts
  registered kinds to the Engine's `SourceScope` port (`registry.ts`), and the
  chat plugin (`chat.ts`): the Polymath chat surface as intake — stable
  trigger ids from the message's stream identity, the agent's own messages
  dropped, the read position advanced only after every covered trigger was
  stored, and the channel defined over the existing ChatFrame stream
  contract, with no new transport.

## Decide (`decide/`)

The Mercury Decide seam (`POST /v1/decisions`, Inception Labs), a wave-1
module beside the core rather than in it: `types.ts` is the typed wire
contract (binary-probability `noul`, categorical `choice`, ordinal `score`,
and text-span `extract` questions over a shared text/JSON state; typed
answers with calibrated probabilities; no streaming, no tool calling);
`client.ts` is the thin HTTP client (Bearer auth, timeout, typed
`DecideError` paths with a `retryable` flag); `record.ts` is the
`AssessmentDecisionRecord` — the Eve judgment, the Decide probability, and
the final decision with which path decided it — plus the escalation rule
(`resolveAssessmentDecision`): below-threshold probabilities and material
Eve/Decide disagreement record not-admitted for the panel to surface.

It is a fourth port beside `Assessor` and `Executor` in the core's port
family, consumed by the assessor implementation. The Engine never imports
it: no Decide in core, so the Engine stays deterministic. The
decisions-only model id `mercury-decide` is declared in `client.ts`
(`DECIDE_MODEL_ID`), not in the chat model catalog — it does not serve
`/chat/completions`.

## Tests

`tests/unit/superagent/core-engine.test.ts` and `stage.test.ts` are the
prototype's core-engine and stage specs, ported with the same renames and
driven from in-memory repositories: receiving, gate, assessment, fan-out,
resume and stop, interrupted runs, pause, policy changes, reports, attaching,
replies, and failed deliveries; the stage spec checks the table row by row.
`sources-chat.test.ts` is the chat Source's spec: trigger id idempotency,
the own-message drop, the listen-versus-observe scope through the registry,
the read position (start from now, replay-safe rounds), and the channel
returning `sent` or `gone`, never both, with frames that round-trip the
stream contract.
