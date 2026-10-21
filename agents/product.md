# product.md — Direction, decisions, and boundaries

**Purpose:** what to build, what is already decided, and what is out of scope.
Behaviour is owned by [axiom-product-spec.md](../docs/axiom-product-spec.md) and
the Notion Product Spec; this file owns stance.

**Naming:** the product is **Polymath**. The repository, package, and docs were
renamed from Axiom in `d9bd844`.

Process and the agent org are in [agent.md](agent.md). System map in
[architecture.md](architecture.md). Commands in [reference.md](reference.md).

## Thesis

Polymath is a workspace for people whose work is thinking. It converts
everything entering one person's world — mail, files, pages, ideas, roles — into
an ordered, trustworthy plan; keeps knowledge connected and retrievable; and lets
supervised agents do the work without quietly taking control.

The product exists because knowledge work fails in four specific ways: menial
work crowds out creative work, notes are written and never revisited, focus
drifts, and effort is invisible.

**The library is the asset.** A person's accumulated knowledge, stored well and
retrievable, is the most valuable thing the product holds. Every feature either
enriches the library or helps use it.

## Three pillars

1. **The library** — sources, notes, claims, cards, links, retrieval.
2. **The work** — tasks, sessions, stones, areas, effort and confidence reported
   separately.
3. **The agents** — a supervisor, sub-agents invoked as tools, durable runs,
   authority that narrows on delegation.

The loop (Capture → Clarify → Commit → Focus → Review → Learn) is the mechanism
inside the pillars, not a fourth structure.

## First principles

1. **Capture never blocks.** Entry speed outranks enrichment completeness. A
   capture is recorded before anything tries to understand it.
2. **Objects before pages.** Sources, notes, claims, cards, links, tasks,
   sessions, areas, runs are canonical. Screens are views.
3. **One record, many views.** A second task store to get a nicer screen is a
   bug.
4. **Evidence before confidence.** A number never hides what produced it.
5. **Agents propose; policy disposes.** Model output never overrides
   deterministic authorisation.
6. **Delegation narrows authority.** A sub-agent can never hold more power than
   the agent that invoked it. Enforced in code, tested as an invariant.
7. **No invisible work.** Long jobs expose progress, cost, questions,
   cancellation, and artifacts.
8. **Reward completion, never punish loss.** Stones cannot be taken away. No
   streak can be broken.
9. **Reversible by default.** Uncertain external outcomes become unknown and
   reconcile before any retry.

## Decisions already made — do not re-propose

- **Multi-tenant, multi-person.** A user belongs to one or more workspaces.
  Every record carries `workspace_id`. Roles are owner, editor, viewer.
- **Generic ICP, not one person's habits.** The product is designed for the
  class described in the spec, not modelled on the owner.
- **Twelve core resources.** `workspaces`, `users`, `memberships`, `sources`,
  `notes`, `claims`, `cards`, `links`, `tasks`, `sessions`, `areas`, `runs`.
  Everything else is a capability over these.
- **Source and Document are the same thing.** One immutable captured artifact.
- **Pursuit replaces Opportunity** as the frame for anything driven toward an
  external outcome.
- **Stones are gemstone records**, three intensity tiers, never revoked, never
  points or streaks.
- **Effort and knowledge confidence are separate measures**, never a composite.
- **Phase 0 spine before parallel phases.** Identity, tenancy, receipts, audit,
  a queue that drains — then phases 1 to 4 in parallel.
- **Next.js 16 modular monolith on Neon Postgres.** Not FastAPI, not SQLite, not
  microservices.
- **One supervisor agent per workspace, personified by the operator**
  (revised 2026-10-21, supersedes "Alfred is one first-party agent plus a fixed
  sub-agent roster"). The workspace's supervisor is the user's own
  representation — named, shaped, and aimed by them, learned at onboarding from
  who they are and what they want done — not a fixed "Chief of staff" persona
  shipped from the factory. The roster of sub-agents it may delegate to stays
  fixed; still not a persona zoo.
- **A conversation is home.** The root lands on the Assistant; the first move is
  to say what you want, not to browse. Today is one click away and still where
  the day is decided.
- **Donor repos are frozen.** `~/Projects/{command-center,alfred,neuralflow}` are
  read-only references. Never edit them.

## Feature boundaries

**In v1:** capture and queue, library and search, notes and claims and cards,
links, tasks, sessions, stones, areas and progress, agents and runs, proposals
for external action, tenancy and membership.

**Roadmap, not v1:** financial reconciliation, legal citation, mobile, MCP
server, public API, per-resource sharing, org hierarchies, custom roles.

**Never:** a feature whose only safety story is "the model will be careful"; a
fabricated personal claim; name-only person merging; credential harvesting;
CAPTCHA or access-control bypass.

## Voice

Interface text is written from the person's side of the screen and named by what
they control. Active voice. A button says exactly what happens and the
confirmation repeats that word. Sentence case, plain verbs, no filler, no
exclamation marks. Errors state what happened and how to fix it; they never
apologise and never guess. An empty screen is an invitation to act.

Vocabulary is consistent across the product: *source*, *note*, *claim*, *card*,
*link*, *task*, *session*, *stone*, *area*, *run*, *proposal*. A synonym is a
bug.

## Success

Activation: capture five items, approve one proposal, complete one session, earn
one stone.

Guardrails never traded away: zero cross-workspace leaks, zero duplicate
external effects, zero writes without policy or approval, zero spend above
budget, zero unresolved external outcomes older than 24 hours.
