# ADR 0001: Professional workspace scope

**Status:** Accepted
**Date:** 2026-10-17
**Amends:** docs/axiom-product-spec.md (§ Users), agents/product.md (§ Thesis)

## Context

The product spec says "The primary user: a single owner in v1; tenant-ready by
design." That stays true for the schema and for the v1 behaviour. This ADR
decides what the product evolves *toward*, so that terms and object boundaries
are fixed before child tickets build on them.

The target is a **configurable professional workspace** for independent
professionals and small businesses — a lawyer in India, an accountant in India,
a software engineer in the US — via optional **workflow packs** layered over one
shared core. It is not three backends: the three-app presentation (Command
Center, NeuralFlow, Alfred) and the single Postgres system of record are
unchanged. A pack adds vocabulary, record types, and journey scaffolding; it
never forks the task, contact, or approval models.

## Decision

### Terms

**Workspace** — the tenancy boundary. All owned rows carry `workspace_id`.
Everything below is scoped to one.

**Person** — a workspace-scoped natural human. Created per workspace; the same
human appearing in two workspaces is two Person rows. May have no sign-in.

**Organization** — a non-human party: company, firm, court, employer. Same
scoping rule as Person.

**Account** — an authenticated principal (a Clerk identity). Belongs to at most
one Person per workspace, but existence of an Account is not implied by a
Person.

**Membership** — the Account↔Workspace access grant. The *only* source of
authorization. Role lives here (owner, member, later: client, viewer).

**Party** — optional shared superclass for Person and Organization, so a
matter/engagement/project can reference "a party" without caring which. Do not
force every table through it; introduce it when a second consumer exists.

**Customer** — a business relationship (a Person or Organization the
professional serves). **Not an authorization role.**

**Subscriber** — a subscription plus billing account (who pays for the
workspace). **Not a Person enum** — a workspace's subscriber may be an
Organization, and the payer need not be a member.

**Business classification vs authorization role** — classification describes
what someone *is* to the business (customer, vendor, counterpart, subscriber).
Authorization describes what they *may do* (via Membership). The two are stored
separately and never derived from each other.

**Workflow pack** — an optional, installable configuration adding domain
vocabulary, record subtypes, capture prompts, and journey scaffolds to a
workspace. Packs compose over the core; a workspace with zero packs behaves
exactly as the spec's single-owner baseline.

### Invariants

1. A Person (or Organization) with no Account, or an Account with no
   Membership, has zero access.
2. Becoming a Customer grants no permissions. Becoming a Subscriber grants no
   permissions. Only Membership does.
3. Never globally merge People across workspaces by email or name. Same-email
   rows in different workspaces are independent; any linking is per-workspace
   and requires review (the CRM dedupe rule, scoped down, not up).
4. A pack cannot add a second task universe, note universe, or approval
   pipeline. If a pack wants those, it extends the existing ones.
5. `workspace_id` on every owned table remains the first tenancy check, before
   any pack or role logic.

### Professional journey fixtures

Each completes the same loop — capture → commitment → outcome — over core
objects only. No profession-specific compliance claims.

**Lawyer / client matter follow-up.** A forwarded client email enters Inbox as
an unprocessed Capture; it is clarified into a Contact (Person), an
Organization (the client firm), and a Task under a matter (a Space/project),
with a Commit (outcome) to send a status update by Friday. The follow-up is
drafted as correspondence, becomes an action proposal, passes Review, and is
sent — recorded as the outcome with an audit event. Objects: Capture, Contact,
Organization, Space/project, Task, Outcome, action proposal/attempt.

**Accountant / client document deadline.** A recurring engagement (Space) with
a Contact carries a deadline-driven Task set; a missing document is a Capture
converted to a Task with a due date, committed as this week's outcome. Alfred
prepares the request draft; the Review queue approves the send; the returned
document lands as a Document with lineage, closing the Task and writing the
outcome. Objects: Capture, Contact, Space/project, Task, Outcome, Document,
proposal/attempt.

**Engineer / stakeholder project decision.** A stakeholder thread is captured,
clarified into a Contact and a linked Note; the open question becomes a Task
("decide X") with a commitment (outcome) to answer by Wednesday. Alfred drafts
the decision memo as an artifact with cited sources; the owner approves sending
it via Review; the outcome records the decision with links back to the note.
Objects: Capture, Contact, Note/artifact, Task, Outcome, proposal/attempt.

### v1 inclusions

- Workspace, Account, Membership, Person, Organization (as plain tables over
  the existing identity/CRM schema).
- Customer and Subscriber as relationship records, not roles.
- One default workflow pack: none — the baseline behaviour.
- Three professional journeys as E2E test fixtures over core objects.

### v1 exclusions

- Client-facing portals or external sign-in (a Customer accessing anything).
- Workflow pack marketplace or pack authoring UI.
- Cross-workspace identity resolution or SSO for customers.
- Billing automation (Subscriber is a record; no payments in v1).
- Party superclass, until a second consumer of "either Person or Organization"
  exists.

### Release gates

A professional-workspace release ships only when:

1. Every route and query proves tenancy via `AuthContext.workspaceId`; a
   Customer or Subscriber record with no Membership cannot reach any read path.
2. The three journeys pass as Playwright E2E tests against real Postgres,
   including the tenancy and no-access invariants above.
3. A workspace with no packs is indistinguishable from the current single-owner
   baseline (schema and behaviour).
4. Cross-workspace merge attempts are blocked and audited.

### Authorization matrix (ASH-120 F03)

Roles are hierarchical: owner > admin > member > viewer. Membership is the only
grant; Customer and Subscriber records confer nothing. Resolution lives in
`src/domains/identity/resolve.ts` (`resolveAuthContext`, wired through
`src/lib/auth.ts`); the guards (`requireRole`, `assertWorkspaceScope`) live in
`src/lib/auth/guards.ts`. The matrix below is the target state the guards
express — wiring every route through them is the F04+ enforcement work, so
today the resolution spine is enforced but the per-capability checks are not
yet called at each surface.

| Capability        | owner | admin | member | viewer |
|-------------------|:-----:|:-----:|:------:|:------:|
| Briefing read     |   ✓   |   ✓   |   ✓    |   ✓    |
| Work read         |   ✓   |   ✓   |   ✓    |   ✓    |
| Work write        |   ✓   |   ✓   |   ✓    |        |
| Reviews approve   |   ✓   |   ✓   |        |        |
| Settings write    |   ✓   |   ✓   |        |        |
| Membership manage |   ✓   |       |        |        |

Postgres RLS is defense-in-depth on top of the `workspace_id` query-scope check
and is deferred to a later ticket (F11/F12 territory). Custom role definitions
beyond the four fixed roles are post-v1.

## Consequences

- The spec's "single owner in v1" line is amended to "single-owner baseline;
  professional workspace as the evolution target" — schema decisions taken now
  (Person/Organization split, relationship-vs-role separation) avoid a
  migration later.
- Authorization review surface stays small: one table (Membership) answers
  "may this principal act," which keeps the risk-table policy mechanical.
- Packs are a configuration problem, not an architecture problem, precisely
  because invariants 1–5 are enforced before any pack exists.
- Cost: two more tables and a role column now, versus a tenancy refactor later.
  The single-owner workflows gain no UI in v1; owners who never add a client see
  nothing change.
