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
| Source                | Source (protocol, wave 2)   | `sources/` (later wave) |
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
- `ports.ts` — the seams: `Policy`, `Assessor`, `Executor`, `Outbox`,
  `Repositories`, and the source-scope protocol. No implementation.
- `ids.ts` — deterministic, idempotent keys (`key(...)`) hashed with
  SHA-256, so the same source event always yields the same id.
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

## Tests

`tests/unit/superagent/core-engine.test.ts` and `stage.test.ts` are the
prototype's core-engine and stage specs, ported with the same renames and
driven from in-memory repositories: receiving, gate, assessment, fan-out,
resume and stop, interrupted runs, pause, policy changes, reports, attaching,
replies, and failed deliveries; the stage spec checks the table row by row.
