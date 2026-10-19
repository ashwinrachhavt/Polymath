# ADR 0005: Typed, customizable business relationships

**Status:** PROPOSAL - nothing here is decided or approved. This records one
coherent design for ASH-120 F04, mapped against what F02 already shipped, so
the owner can accept, amend, or reject it as a whole. F03 (the membership and
invitation lifecycle F04 was specified to depend on) is not yet built; the
dependency is called out where it bites.
**Date:** 2026-10-19
**Refs:** ASH-120 (F02, F03, F04), ADR 0001, ADR 0002

## Context

F02 shipped canonical parties as typed tables: `people`, `organizations`,
`contact_points`, `party_relationships` (a fixed-kind classification edge),
and `party_employment` (a dedicated two-ended table). That choice - typed
tables over a superclass - is working and this proposal builds on it rather
than revisiting it.

F04 asks for workspace-defined relationship types: `employed_by`,
`represents`, `billing_contact_for`, `customer_of`, `referred_by`, with
immutable keys, editable labels, forward/inverse labels, constrained
endpoints, direction, cardinality, temporal validity, and an archive policy.
The ticket forbids the unconstrained `entity_type`/`entity_id` anti-pattern
and repeats the house rule: a business edge never grants access.

Two pressures shape the design:

1. **Fixed critical relations deserve their own tables.** `party_employment`
   already proves it: the import path needs a current-edge unique index and
   employment-specific columns (`title`, `started_at`, `ended_at`) that a
   generic edge table would hold as nullable extras or jsonb.
2. **Long-tail relations cannot each be a table.** A workspace that wants
   `board_member_of` should not wait for a migration. Definitions must be
   data, validated against a constrained edge table.

## Proposal

### Keep dedicated tables for fixed critical relations

`party_employment` stays as-is. A relation earns a dedicated table when the
product gives it behavior of its own (import semantics, current-edge
uniqueness, relation-specific columns). That bar is deliberately high.

### One constrained edge table for configurable relations

`party_relationship_definitions`: workspace-scoped, immutable key (same
pattern as role definitions in ADR 0002's ASH-121 work), editable labels,
forward/inverse labels, allowed endpoint kinds per side (`person`,
`organization`, or either), directed vs symmetric, cardinality per side
(one/many), whether self-links are allowed, archived-not-deleted. Definition
edits follow the immutable-revision pattern so a stored edge can always be
read against the definition version it was written under.

`party_relationship_edges`: one row per edge - definition, source endpoint,
target endpoint, optional temporal bounds, workspace-scoped throughout.
Endpoints are constrained in two layers, because a polymorphic target
carries no real FK (the contract `linkTargetKinds` already documents): a
check constraint pins endpoint kinds to the catalog, and the domain layer
validates existence and the definition's endpoint-kind rules inside the
tenant. Where an endpoint kind maps to a typed table, a composite
`(workspace_id, id)` FK per endpoint column keeps cross-tenant endpoints a
constraint violation rather than an application check someone forgets.

The existing fixed-kind `party_relationships` table migrates into this model
as built-in definitions (keys `customer_of`, `vendor_of`, ...), preserving
row ids so references survive. Migration mechanics are a deliverable of the
implementation slice, not this ADR.

### Inverse navigation is one edge, read two ways

Never two rows. A symmetric definition stores endpoints in canonical order
(least id first) with a unique index over the unordered pair; a directed
definition stores source/target and the inverse label is a read-time
projection of the same row. "Who represents Acme?" and "who does Acme's
representative act for?" query one edge.

### Cardinality and concurrency

Cardinality-one sides are partial unique indexes (`WHERE ended_at IS NULL
AND revoked IS NULL`-style), the same pattern as
`party_employment_current_key` - correct under concurrent writes because the
database, not the command, holds the line. Many sides carry no index.
Commands run the state guards inside the receipt callback so retries replay
rather than fail on state the first attempt changed (the lesson of the
role-definitions slice).

### Temporal validity and archiving

Edges carry `started_at`/`ended_at`; "current" is `ended_at IS NULL`.
Closing an edge sets `ended_at`; nothing deletes. Archiving a definition
forbids new edges and preserves every existing one - history outlives
configuration, matching the role-definition archive policy.

### Inference produces proposals, never edges

Imports and agents that believe a relationship exists write a reviewable
proposal (status pending, with evidence), surfaced through the outbox. A
human accepts or dismisses; acceptance writes the edge through the same
command a manual entry uses. No silent materialization - this is the
relationship-surface expression of "background agents surface only judgment
items".

### Authorization stays out

An edge is a business fact. ADR 0002's rule stands unchanged: membership is
the only source of authorization, and a `customer_of` or `billing_contact_for`
edge grants nothing. If a future product rule wants "a billing contact sees
the invoices for their organization", that is a separately approved
authorization rule (ASH-121 AC04 grants), never an implication of the edge.

## Where the F03 dependency bites

F04 was specified to depend on F02/F03. F02 is shipped. F03 (membership and
invitation lifecycle) matters here only at one point: guest-shared relations
and the "reviewable proposal" surface both assume the membership states F03
owns. This proposal therefore scopes edges to party endpoints only
(`people`, `organizations`) and leaves membership-flavored relations
(`account_manages_workspace`, delegated-bookkeeping styles) out until F03
lands.

## Open questions for the owner

1. Built-in definitions only, or workspace-authored definitions in v1? The
   table supports both; the editor UI is the real cost. Proposal: built-ins
   plus a definition-seeded path, workspace authoring when the admin console
   (AC06) exists.
2. Does `party_relationships` migrate into edges, or stay as the fixed
   classification table alongside them? Migration keeps one model; keeping
   both is less churn. This proposal favors migration.
3. Cardinality beyond one/many (exactly-one, one-per-organization) - needed
   for any launch relation, or YAGNI until a real definition asks?

## Consequences if accepted

- Two new tables plus the `party_relationships` migration, all additive or
  data-preserving; composite FKs extend the tenant fence to every endpoint.
- The import path's relationship inference becomes proposals, changing what
  import review screens show (a product-visible change to flag before
  building).
- Nothing about access control changes; ADR 0002 remains the authority.
