# Glossary — workspace terms

The tenancy and relationship terms are defined in
[ADR 0001](adr/0001-professional-workspace-scope.md); all rows are scoped to
one workspace. Classification (what someone is) never implies authorization
(what they may do). The destination terms below come from the IA
simplification (owner decisions, 2026-10-22).

## IA destinations

The four content homes, decided by where material came from. Use these
labels and no synonyms.

- **Notes** — `/alfred/notes`. Pages the person writes. The spec's former
  "Notebook" (the notes surface) is now Notes.
- **Document Vault** — `/alfred/knowledge`. Documents and statements the person
  uploaded. Retires "Library" as a destination label; shows uploaded documents
  and statements only.
- **Notebook** — `/alfred/dossiers`. Bounded source sets with cited answers;
  sources are tracked inside it through the Add-sources control. Absorbs the
  former "Dossier" definition; the URL keeps `/dossiers/*` (cosmetic debt,
  recorded in DESIGN.md §15).
- **Artifacts** — `/alfred/artifacts`. The list of LLM-generated kept outputs:
  reports, decks, infographics, zettels, wiki pages. Retires "Generated" as a
  label; raw saved answers stay in their conversation thread.

Removed from the rail, and where their function went: Learning (deleted
entirely, tables dropped in migration 0235), Spending (a Today tab),
Opportunities (records live under People and Companies), Focus (sessions start
from Work), Sources (tracked inside the Notebook), Wiki (pages surface in
Artifacts).

## Workspace

The tenancy boundary; every owned row carries `workspace_id`.

- **Example:** "Ashwin Law Chambers" — one workspace containing its own
  contacts, matters, and members.
- **Counterexample:** two workspaces sharing a contact row, or a query without
  `workspace_id` in scope.

## Person

A workspace-scoped natural human. May have no sign-in.

- **Example:** *Meera Iyer*, a client contact row in the chambers workspace.
- **Counterexample:** assuming Meera in the chambers workspace and an
  m.iyer@example.com Person in another workspace are the same row, or merging
  them by email.

## Organization

A non-human party: company, firm, employer, court.

- **Example:** *Iyer Textiles Pvt Ltd*, the client firm on a matter.
- **Counterexample:** using Organization for the "family office" of one Person
  who just wants a shared label — that is a Person with a relationship, not a
  company.

## Account

An authenticated principal (a Clerk identity). At most one per Person per
workspace.

- **Example:** Meera's `meera@…` Clerk sign-in, linked to her Person row.
- **Counterexample:** creating an Account for every Contact "so they can log in
  later" — an Account exists only when issued.

## Membership

The Account↔Workspace access grant. The only source of authorization; the role
lives here.

- **Example:** Meera's Account has a Membership with role `viewer` in the
  chambers workspace, so she can read what matters expose to clients. (A
  per-matter `client` role is post-v1; today the enum is owner, admin,
  member, viewer.)
- **Counterexample:** "she's the customer, let her in" — no Membership, zero
  access, however important the relationship.

## Party

Optional shared superclass for Person and Organization, so a record can
reference either. Introduced only when a second consumer exists.

- **Example:** a matter's `parties` list referencing Meera (Person) and Iyer
  Textiles (Organization) via one Party supertype.
- **Counterexample:** forcing every table's foreign keys through Party from day
  one with a single consumer — speculative abstraction.

## Customer

A business relationship with a Person or Organization the professional serves.
**Not a role.**

- **Example:** Iyer Textiles, with status `active`, linked to two matters.
- **Counterexample:** a Customer with no Membership — zero access. Being a
  customer grants no permissions.

## Subscriber

The subscription plus billing account — who pays for the workspace. **Not a
Person enum.**

- **Example:** Iyer Textiles Pvt Ltd subscribes to a pack-enabled workspace;
  the billing contact is Meera, a non-member.
- **Counterexample:** a `type: subscriber` value on Person, or assuming the
  payer is a member — the payer need not be, and Subscriber is a record, not an
  identity classification.

## Business classification vs authorization role

Classification (customer, vendor, counterpart, subscriber) describes the
relationship. Authorization (via Membership) describes capability. Stored
separately, never derived from each other.

- **Example:** Meera is `customer` (classification) with Membership role
  `client` (authorization) — two fields.
- **Counterexample:** a permission check reading `contact.status == 'customer'`
  instead of the Membership role.

## Workflow pack

An optional, installable configuration adding vocabulary, record subtypes, and
journey scaffolds over the core. Cannot fork the task, note, or approval
models.

- **Example:** a "Legal matters" pack adding matter subtypes and follow-up
  capture prompts to a workspace.
- **Counterexample:** a pack shipping its own task table because matters "need
  different statuses" — a second task universe is a bug (agents/product.md §
  First principles).
