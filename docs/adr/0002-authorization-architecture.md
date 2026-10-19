# ADR 0002: Human and agent authorization architecture

**Status:** Accepted (documents as-built state and the decided direction)
**Date:** 2026-10-19
**Refs:** ASH-120 (F03/F06), ASH-121, ASH-122, ASH-131, ADR 0001

## Context

Axiom has humans (Clerk sessions), machine clients (API tokens), and agent
runs acting on one workspace-scoped record set. Before this ADR the pieces
existed but the architecture binding them lived in Linear tickets and code
comments. This records what is built, what is decided, and what is open, so
the access-control epics (ASH-121/122) and the runtime tickets (RT02-04)
extend one design instead of inventing parallel ones.

## Decision

### One tenant boundary, one source of authorization

Every owned row carries `workspace_id`; queries scope at the source
(`eq(table.workspaceId, ctx.workspaceId)`), so a foreign id is "not found",
never fetched-and-rejected. **Membership is the only source of authorization**
(ADR 0001): business records (customer, subscriber, party relationships) grant
nothing. Roles are read from the `memberships` row at resolution time, never
from session claims or client input, and only `status = 'active'` memberships
resolve — suspension needs no cache flush.

### Two authenticated principals, one context shape

- **Humans**: Clerk session → `resolveAuthContext` → `{ userId, workspaceId, role }`.
- **Machines**: Clerk-verified token → `resolveMachineClient` → the api_client
  row *is* the identity (no client-supplied id); revoked, expired,
  rate-limited, and unknown are the same refusal. v1: a machine client acts
  with its workspace's owner role.

Both produce the same `AuthContext` and pass the same guards. Webhooks stay on
HMAC (`webhook_inbox`) and never become an `AuthContext`.

### Enforcement at every entry-point class

- Edge proxy: default-deny; only sign-in/up and webhooks are public.
- Server actions: every exported action reaches `requireRole` via a per-file
  `authorize()` helper; a CI test (`server-action-authorization.test.ts`)
  sweeps every `"use server"` file so a new unguarded mutation fails CI.
- Route handlers: `authedHandler` + `requireRole` on mutations.
- Reads need membership (viewer); writes need member; administration will need
  admin when admin surfaces exist.
- Domain commands are the last line, not the first: role checks live at the
  boundary by design ("one guard per concept"), resource scoping lives in the
  queries.

### Agents act inside run-grants, never ambient authority

An agent run is not a principal: it executes under the intersection of the
delegating member's authority and its frozen admission snapshot
(`agent_runs.policy_snapshot` — profile, model, tools, accounts, budget, frozen
at start). Runtime access goes through the RT02 `AgentRuntime` contracts:
capability grants carry operations/resources/accounts/expiry, dispatch keys
and durable signal IDs make retries safe, execution generations fence stale
callbacks, and inspection returns observations — canonical state changes stay
with `AgentRunService`. Spend is a reservation committed before the session
starts and released when it ends. Scheduled automation must use an owned
service principal, never the last editor's ambient account (direction; the
principal type does not exist yet).

### Audit and denial are part of the contract

Every domain command writes `recordAudit` in the same transaction as the
mutation and emits an outbox event for downstream consumers; the outbox
dispatcher leases by dispatch key so a crash cannot double-fire. Denied calls
produce no mutation and no provider effect; a foreign id and a missing id are
the same "not found".

## What is deliberately not decided here

- Custom roles and a capability catalog (ASH-121 AC03) — v1 has the four fixed
  roles; the RANK comparison is the whole surface.
- Resource-level grants, guests, and inheritance (AC04).
- RLS as database defense-in-depth (AC05) — evaluation pending; the runtime
  role must not silently bypass it either way.
- Field-level redaction and export grants (AC07).
- The agent tool-authorization gateway (ASH-122 GA03) and the RT01 Eve
  responsibility decision (ASH-115) that scopes it.

## Consequences

- A new entry point has no authorization work to invent: wrap in
  `authedHandler`/`getAuthContext`, call `requireRole`, scope queries by
  workspace. The CI sweep enforces the first two.
- A new agent capability ships as an `allowedOperations` entry plus a profile
  revision; existing runs never see it (frozen snapshots; a policy tightening
  applies to subsequent admissions only).
- Machine tokens are revocable without touching human sessions, and vice
  versa.
