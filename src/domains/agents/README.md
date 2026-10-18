# agents

Owns: profiles, threads, messages, checkpoints, runs, steps, tool calls, questions, run events, memory

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
(agents/engineering.md). Enum values are the contract: add a value, never
repurpose one.

Eve tools resolve their run UUID and frozen policy through the persisted
session_ref plus authenticated workspace. Missing, ambiguous, or terminal
bindings fail closed; tasks.read returns bounded canonical open tasks.

The header-based Eve channel is a local-development spike, not Clerk
authentication. It is disabled in production and whenever Clerk is configured;
run creation then returns agent_bridge_unavailable before reserving spend.
Verified scoped identity transport, enforced runtime model/budget snapshots,
start/binding reconciliation, signal/resume and terminal lifecycle handling
remain unfinished (ASH-119/ASH-134). Do not treat this bridge as production-ready.
