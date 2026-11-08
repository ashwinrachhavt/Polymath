# Data ownership, relations, and query performance

## Model invariants

- Each domain owns its tables and query interface. UI code consumes domain operations rather than reconstructing cross-domain ownership rules.
- Express required values, uniqueness, and valid relationships as database constraints when possible. Types and UI validation alone cannot protect concurrent writes.
- For workspace-owned relations, enforce that both sides belong to the authorized workspace. Use an appropriate composite key/foreign key where feasible and retain scoped application checks. A foreign key to an ID alone does not enforce tenant equality.
- Choose nullability from domain meaning. Distinguish unknown, not applicable, and empty when users or algorithms need that distinction. Choose deletion behavior explicitly; cascade only for children whose lifecycle truly belongs to the parent.
- Use transactions for related state changes. Use conditional updates, uniqueness, or locking to protect concurrent transitions. Persist intended external work in the same transaction, then execute it after commit; a database transaction cannot roll back a remote provider action.

## Query design

- Select only needed columns and bound result counts. Use stable ordering with a unique tie-breaker; use cursor pagination for large mutable lists where offset pagination becomes costly or inconsistent.
- Batch related reads or join intentionally to avoid one query per row. Inspect row multiplication and tenant predicates in joins. Keep aggregate work in the database when it reduces transferred data without changing semantics.
- Design indexes against observed filters, joins, ordering, and selectivity. Account for write and storage cost. A foreign key declaration does not itself guarantee an index on the referencing columns.
- Measure before and after optimization with representative data and the query plan. Use `EXPLAIN ANALYZE` only where executing the query is safe; it executes the statement. Record row counts, query count, and latency instead of claiming improvement from SQL appearance.
- Cache only with an explicit scope, invalidation rule, and freshness requirement. Include authorization-relevant scope in keys. Keep correctness independent of a warm cache.

## Migrations and evidence

Follow [migration instructions](../../src/db/migrations/README.md) and [repository hygiene](../../docs/repo-hygiene.md).

Applied SQL and journal history are append-only. Stage compatible schema expansion, data backfill, caller migration, and contraction when a single-step change would break running code. Inspect the actual journal for the current baseline; do not copy migration numbers into these instructions.

For schema or query changes, verify cross-workspace isolation, relation constraints, null handling, pagination boundaries, and relevant concurrent writes. Run migration and snapshot checks when their inputs change, against a designated test database. Preserve production and shared development data.
