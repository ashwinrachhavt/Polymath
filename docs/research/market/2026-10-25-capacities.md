# Market research: Capacities

**Date:** 2026-10-25 · **Analyst:** overnight build session · **Status:** current as of 2026-10-25 sources
**Category:** object-based personal knowledge management.

## What it is

A European indie PKM built on one idea: **you don't create files, you create
objects** - people, books, projects, meetings - each a typed thing with
properties, templates, and a place in a network. It is the most polished
execution of the "typed knowledge graph for individuals" thesis, and the
closest structural cousin to Axiom's domain model. 50,000+ active users. [S1]

## Current feature set (verified 2026-10-25)

- **Objects with custom types**: user-defined types with properties (dates,
  ratings, tags, links, checkboxes), templates per type, and multiple views
  (list, gallery, table, cards) over the same data. [S1]
- **Daily notes + calendar integration** (Pro). [S1][S2]
- **Capture routes**: WhatsApp, Telegram, Twitter/X, and email-in on the free
  tier; Readwise and Kindle on Pro. [S2]
- **AI assistant** (Pro), image/PDF/weblink analysis (Pro), AI chat
  connectors (Pro). [S2]
- **Task management with task actions** (Pro). [S2]
- **Smart queries** (Pro) - saved structured queries over the object graph. [S2]
- **Public API** (Pro), full import/export, offline support, view-only
  sharing. [S2]

## Business model

Freemium with a written "core stays free" promise: Free is genuinely usable
(unlimited spaces/objects/types, sync); Pro $9.99/mo adds AI, tasks, smart
queries, calendar, API; Believer $12.49/mo is patronage + beta access. [S2]

## Strengths

- **The typed-object model works**: structure without Notion's ceremony, and
  the type system is the organizing principle rather than an add-on.
- Free tier honesty as marketing ("our promise"), indie sustainability story.
- Every capture channel meets users where they already are (WhatsApp/Telegram).

## Weaknesses

- **Cloud-only, proprietary format**: export exists, but the objects live in
  their cloud; no local-first, no self-host.
- AI is a paid assistant bolted onto the object graph, not a pipeline that
  maintains the graph - no verification, no proposals, no agent tooling.
- The object model is rigid where it matters: types are user-defined but the
  app's surfaces are fixed; you cannot build your own workflows over them
  beyond smart queries.

## What Axiom can assimilate

1. **Typed capture targets.** Capacities proves individuals adopt typed
   objects when the types are theirs. Axiom's capture_proposal_kind enum
   (note/task/contact/project/event/...) is the same idea at the pipeline
   level; the type catalog (ASH-272) is the classifier's version. The lesson:
   show the type's structure at capture time so the proposal feels like
   filing, not guessing.
2. **Capture channels matter more than capture UI.** WhatsApp/Telegram/email
   ingest on the FREE tier is how they win daily use. Axiom's capture sources
   (quick capture, URL, file, extension) could add email-in cheaply - the
   ingestion pipeline already exists.
3. **Smart queries = saved views**, converging with the Obsidian Bases
   takeaway: named, structured, re-runnable queries over the graph as
   first-class objects.
4. **Multiple views over the same data** (list/gallery/table/cards) for the
   knowledge surfaces.

## Where Axiom can differentiate

1. **The pipeline, not just the graph**: Capacities stores typed objects the
   user files; Axiom's ladder (normalize -> structure -> enrich -> classify ->
   propose) files them *for* the user with a human accept gate.
2. **Claim-level truth**: zettels with verified quotes vs. objects with
   properties someone typed.
3. **Agents that act** (Eve tool surface, outbox-processed side effects) vs.
   an AI assistant that answers.
4. **Local-dev + own-DB posture** vs. their cloud.

## Sources

- [S1] Capacities product page - https://capacities.io/product (2026-10-25)
- [S2] Capacities pricing - https://capacities.io/pricing (2026-10-25)
