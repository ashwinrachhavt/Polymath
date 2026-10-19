# ADR 0004: Row-level security evaluation (ASH-121 AC05)

Status: evaluation, verified by CI probe (tests/integration/rls-evaluation.test.ts)

## Context

ADR 0002 deliberately left RLS undecided: "RLS as database defense-in-depth -
evaluation pending; the runtime role must not silently bypass it either way."
AC05 wants that evaluation against the actual Neon/Drizzle connection
behavior, not against documentation. Authorization remains an application
concern (guards.ts, entry-point enforcement); RLS, if adopted, is a second
line underneath it.

## What the probe establishes

The integration suite runs a probe against the CI Postgres (Neon) and the
findings below are what it asserts on every run; a regression in any of them
fails CI rather than letting this ADR go stale:

1. The role the application connects as (recorded per run: superuser /
   BYPASSRLS flags).
2. Whether this environment can create a separate, non-privileged runtime
   role at all. If it cannot, that is recorded as the finding and the rest of
   the probe reports nothing - the ADR must not claim posture the environment
   cannot express.
3. A tenant policy of
   `workspace_id = current_setting('axiom.workspace_id', true)` isolates rows
   under the probe role: the scoped tenant's rows are visible, other tenants'
   are not, and - the fail-closed property - a connection with no tenant
   claim sees nothing.
4. `FORCE ROW LEVEL SECURITY` binds a non-privileged table owner: with the
   probe role owning the table, an owner connection sees zero rows without a
   tenant claim and exactly its tenant's rows with one. This is the property
   that makes RLS meaningful as defense-in-depth against a bug in
   application-level scoping.
5. The application connection itself is not bound, even by FORCE. The CI
   role `axiom` is both superuser and BYPASSRLS (recorded by the probe on
   every run), and such roles ignore RLS entirely: under FORCE with no
   tenant claim it still saw every row. RLS on the app's current connection
   is inert - it is meaningful only under a dedicated runtime role.

## Decision

Evaluation only; no schema adopts RLS in this change. The adoption criteria
this evaluation feeds:

- RLS adoption is meaningless without a dedicated, non-privileged runtime
  role: the app currently connects as a role RLS cannot bind (finding 5), so
  enabling policies on the existing connection would add ceremony with no
  boundary. The runtime role must be non-superuser, no BYPASSRLS, and not
  the table owner (or the table must be under FORCE).
- Adopting means: migration creates the runtime role and grants, the app's
  pooled connections run as it, `axiom.workspace_id` is set per transaction
  from the server-derived AuthContext (never client input), and FORCE is on.
- Any adoption is per-table and additive, with the application guards
  unchanged; RLS is the backstop for their bugs, not their replacement.

## Consequences

- The probe runs in CI, so a Neon role-permission change that breaks the
  posture surfaces as a test failure, not a surprise at adoption time.
- per-request GUC setting has a cost (per-transaction `SET`); the pooled
  connection must never leak a tenant claim across requests - the probe's
  reserved-connection discipline is the pattern any adoption copies.
