# superagent/store

The durable spine of the superagent domain: Postgres tables behind the core's
repository ports, Drizzle as the query layer, and one migration file per
release (owned here, never in `src/domains/agents/schema.ts`).

## Vocabulary

The blueprint's "Thread" is a **WorkThread** here. Polymath's existing
"thread" means a chat transcript; a WorkThread is the work context a Source
event belongs to. "Assignment" is a **TicketRun**; "Eval" is an
**Assessment**. Nothing in these tables reuses a name from the agents schema.

## Layout

- `schema.ts` — the tables. Triggers, threads, assessments, decisions,
  tickets, runs, subscriptions, effects, outbox receipts, and the policy
  settings tables. Generated columns (`is_active`, `needs_attention`) and
  their partial indexes are what let a dispatch pass read only active work.
- `mapping.ts` — pure mappers between core aggregates and rows. No I/O.
- `repositories.ts` — the port implementations. The cache mirrors the core's
  in-memory shape so the engine cannot tell them apart; `flush` is the only
  writer and every flush is one transaction with optimistic CAS on `version`.
- `policy.ts` — the policy document and its rule list (settings-versioned).
- `queries.ts` — SQL-side reads for the post-commit dispatch passes.
- `index.ts` — the module's public surface (factory, flush, queries).

## The flush contract

A command mutates the cache, then calls `flush`. Flush persists dirty
aggregates and receipts in one transaction: inserts become upserts, updates
carry a `WHERE version =` clause, and a lost race fails loudly with
`StoreFlushError` rather than clobbering the outside writer. On failure the
cache is restored to its pre-flush state, so a retried command starts from
disk truth. On success the surviving entries advance one version.

Effects and outbox receipts are enqueue-only writes: the transaction commits
the domain state and the queued effect together, and the post-commit passes
drain them. `work_effects` is append-only until the drain pass lands (wave
two), which will add its update path and its row-state guard in the same
change — see `scripts/lib/row-state.ts`.
