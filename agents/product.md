# product.md — Direction, decisions, and boundaries

**Purpose:** what to build, what is already decided (so it is not re-litigated),
and what is out of scope. Behaviour is owned by
[axiom-product-spec.md](../docs/axiom-product-spec.md); this file owns stance.

## Thesis

Axiom converts everything entering one person's world — mail, files, issues,
pages, ideas — into an ordered, trustworthy plan; keeps knowledge connected; and
lets supervised agents do useful work without quietly taking control.

The loop: **Capture → Clarify → Commit → Focus → Review → Learn.** Every feature
must serve a step in that loop. A feature that serves none of them is a
non-feature, however good the demo looks.

One owner in v1. Tenant-ready schema, single-user behaviour. "Team features" are
schema decisions, not UI decisions, until the owner asks otherwise.

## First principles

1. **Briefing before browsing.** Home answers "what should I do now" without an
   LLM call on load. A dashboard that only reports is not a briefing.
2. **Three apps, one record.** Axiom presents three micro-app experiences —
   Command Center, NeuralFlow, Alfred — over one canonical system of record
   (spec § The suite). The boundary is a product boundary, never a deployment
   or data boundary: a second task table, a second note universe, or a second
   approval pipeline is a bug, however clean the app split looks.
2. **Objects before pages.** Tasks, projects, people, documents, events,
   messages, and runs are canonical records. Screens are views over them.
3. **One record, many views.** List, board, calendar, and focus read one task
   model. Never fork a second task universe to get a nicer screen.
4. **AI proposes; policy disposes.** Model output never overrides deterministic
   authorization. The risk table in the spec is law.
5. **No invisible work.** Long jobs expose progress, cost, questions,
   cancellation, and artifacts. If the owner cannot see it, it did not happen.
6. **Reversible by default.** External writes go through proposals with a
   preview, a risk class, a dedupe key, and an expiry. Uncertain provider
   outcomes become `UNKNOWN` and reconcile before any retry.
7. **Learning follows completion.** Reflection enriches finished work; it never
   blocks it.

## Decisions already made — do not re-propose

- **Consolidation, not federation.** Axiom is one product with one Postgres
  system of record. No permanent proxy layer over donor backends, no iframe shell
  as the end state. *(The `docs/superpowers/.../consolidation-design.md` iframe
  plan was an earlier approach that the Next.js/Neon plan supersedes — follow the
  newer document.)*
- **Three micro-app experiences, one system of record.** Command Center,
  NeuralFlow, and Alfred are product surfaces with their own navigation and
  feature ownership; they are not three systems and not a federation of donors
  behind one shell. This **supersedes the earlier flat ten-destination model** in
  the product spec (2026-10-11); it does not supersede the modular-monolith or
  single-system-of-record decisions. A shared record is never copied to cross an
  app boundary.
- **Next.js 16 modular monolith on Vercel.** App Router, RSC reads, Server
  Actions for first-party mutations, Route Handlers for webhooks/SSE/files.
  Not microservices; not FastAPI/Celery retained after parity.
- **Neon Postgres + pgvector** is the system of record. Object storage holds
  binaries; Neon holds metadata, extracted text, hashes, lineage.
- **Clerk** is the only identity provider. Owner resolves server-side from Clerk;
  clients never select owner IDs.
- **Composio** is the integration layer; **Firecrawl** is the research layer.
  Providers are reached through adapters, never called from components.
- **Donor repos are frozen.** `~/Projects/{command-center,alfred,neuralflow}` are
  read-only references. Never edit them; migrate from them.
- **No autonomous consequential action.** Sending, publishing, deploying,
  submitting, merging, and deleting require policy **and** approval in v1.
- **Alfred is one first-party agent**, not a persona zoo. Profiles exist in
  schema; v1 ships one.

## Feature boundaries

**In v1:** Briefing, Inbox/capture, Work (tasks/projects/spaces/board/calendar),
Focus, Alfred threads and durable runs, Reviews/approvals, Knowledge (notes,
documents, search, flashcards), Relationships, Opportunities, Activity, Settings.

**Deferred — say so in one line instead of building it:** multi-user
collaboration, user-authored code execution, unbounded browser automation,
donor-look unification for long-tail screens, a second agent persona, real-time
multiplexed cursors, mobile-native clients.

**Never:** a feature whose only safety story is "the model will be careful."

## Voice

Interface text is written from the owner's side of the screen and named by what
the owner controls — "Notifications", not "Webhook config". Active voice; a
button says exactly what happens ("Send email"), and the toast repeats that word
("Email sent"). Sentence case, plain verbs, no filler, no exclamation marks.
Errors state what happened and how to fix it; they never apologise and never
guess. An empty screen is an invitation to act, never a mood.

Vocabulary is consistent across the product: *capture*, *clarify*, *outcome*,
*review*, *proposal*, *attempt*, *focus session*, *run*. If a synonym appears in
a mock, rename it.

## Success

Activation: connect calendar and inbox, capture five items, accept one outcome,
complete one focus session, decide one Alfred proposal.

Guardrails that are never traded away: zero duplicate external effects, zero
cross-workspace leaks, zero writes without valid policy or approval, zero spend
above a captured budget, zero `UNKNOWN` actions older than 24 hours.
