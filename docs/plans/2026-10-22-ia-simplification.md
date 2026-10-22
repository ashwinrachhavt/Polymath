# Polymath IA Simplification — one calm rail

**Status:** Draft under /plan-design-review (2026-10-22).
**Owner directive:** simplify the product. Remove Sources, Learning, Wiki,
Spending, Opportunities, Focus from the rail. Rename Dossiers to Notebook.
Rename Library to Document Vault. Create a Generated tab. Notes get their
own page.

Precedence: `agents/*` > CLAUDE.md > DESIGN.md > this file. Where this file
disagrees with the product spec, this file wins until the spec is updated in
the same change (the change updates both).

---

## 1. The content model: four homes by origin

Owner decision (2026-10-22): every piece of material lives in exactly one
home, decided by where it came from.

| Home | Contains | Origin |
|---|---|---|
| **Notes** (`/alfred/notes`) | Written pages, the rich editor | Human writes it |
| **Document Vault** (`/alfred/knowledge`) | Documents and statements | Human uploads it |
| **Generated** (`/alfred/artifacts`) | Reports, decks, infographics, wiki pages, zettels — kept outputs only | The LLM generated it |
| **Notebook** (`/alfred/dossiers`) | Sources: URLs, YouTube videos, files pinned to a bounded set | Human points at it |

A zettel is machine-generated, so it appears in Artifacts (filter
kind=zettel) and is linked from the Notebook that produced it. It has no
rail slot of its own.

## 2. The rail after this change

```text
Assistant        /alfred                              conversation is home
Today            /command-center/briefing             decide the day
Inbox            /command-center/inbox                clarify what arrived
Work             /neuralflow/work                     execute commitments
Notes            /alfred/notes                        human writing lives here
Document Vault   /alfred/knowledge                    human-uploaded documents
Notebook         /alfred/dossiers                     bounded sources, cited answers
Generated        /alfred/artifacts                    LLM-generated outputs, one list
People           /command-center/relationships/people
Companies        /command-center/relationships/companies
Conversations    /command-center/conversations
Connectors       /command-center/integrations
---
Reviews          /reviews                             shared services at the foot
Activity         /activity
Settings         /settings
```

15 destinations, from 20. Removed from the rail: Sources, Wiki, Learning,
Spending, Opportunities, Focus. Skills stays (§3e).

## 3. Where each removed destination's function goes

### a) Sources → into Notebook

The Sources page (`/alfred/sources`) closes. Its two jobs move:

- **Adding material to a notebook** — the Notebook screen's Sources pane
  gains the capture affordance (NotebookLM pattern): an "Add sources"
  control that accepts a URL, a YouTube link, a file upload, or a pick from
  the Document Vault. Sources are tracked in the notebook itself; there is
  no global sources list, because a source outside a notebook is unfiled
  capture, which is the Inbox's job.
- **Capture** — the header Capture button stays. Unfiled captures land in
  the Inbox as today.

URL policy: `/alfred/sources` → redirect to `/alfred/dossiers`. Deep links
to a specific source redirect to the owning notebook, else the Inbox.

### b) Learning → deleted entirely (P0, destructive)

Owner decision 2026-10-22: the Learning review schedule has no plan and no
future. Remove everything:

- Data model: the teaching/review tables (spaced-repetition schedule,
  review items), their migrations — new forward-only drop migration, never
  edited — and the `teaching` domain code.
- Domain code: `src/domains/teaching/` (notebook-context.ts moves to
  knowledge — the notebook-open contract is not learning-specific).
- Routes: `/alfred/learning` (page, actions, learning-surface).
- Agent tools: `learning.review`, `learning_next`, `learning_grade` and
  their capability mappings, evals, and policy references.
- Tests: teaching-contract tests, learning evals, e2e legs.
- The rail entry and the mobile-bar entry.

Data policy (owner decision 2026-10-22): one forward-only drop migration
removes the tables and their rows in this change, with the code deletion.
Irreversible and accepted; the data is test-scale today.

The Notebook's Studio keeps quiz/flashcards OUT. Quiz and flashcard intents
in chat answer with "not built"; no stub UI.

### c) Wiki → folded into Document Vault

`/alfred/wiki` closes. **Vault scope (owner decision 2026-10-22): the
Document Vault shows uploaded documents and statements only — wiki pages do
not appear there.** The wiki ingest and lint controls move into a
document's inspector; wiki pages surface in Generated (machine-generated,
per the origin rule). The wiki-agent and backlinks stay as capabilities.

URL: `/alfred/wiki` → redirect to `/alfred/knowledge`.

### d) Spending → folded under Today

- **A (decided):** the ledger moves to a Today sub-tab; the rail loses
  Spending. `/command-center/spending` redirects to
  `/command-center/briefing?tab=spending`.

### e) Skills — STAYS (owner decision 2026-10-22)

Skills keep their rail slot: they are how the owner shapes their own
supervisor agent (product.md decision, 2026-10-21), and the simplification
directive did not name them.

### f) Opportunities → deleted from nav; records keep a home

The spec already retires Opportunity as a top-level concept. The rail entry
goes; the records remain reachable from People/Companies (a company's
pursuits). `/command-center/opportunities` redirects to People.

### g) Focus → the stage, not a tab

Focus sessions start from Work (a task's "Focus" action) — the reward stage
(DESIGN.md §4.5) renders during the session, not as a standalone
destination. `/neuralflow/focus` redirects to `/neuralflow/work`. Stones and
the collection stay reachable from Today.

## 4. Renames

- **Dossiers → Notebook.** The spec's Notebook (notes surface at
  `/alfred/notebook`) renames to **Notes** at `/alfred/notes` (redirect).
  Glossary: *Notebook* = bounded source set with cited answers (absorbs the
  Dossier definition); *Notes* = written pages.
  **Route (owner decision 2026-10-22): the URL stays `/alfred/dossiers/*`
  with the new label.** Old URLs keep working with zero redirect work; the
  label/URL mismatch is cosmetic debt recorded in DESIGN.md §15.
- **Library → Document Vault.** Label and purpose change only; route stays
  `/alfred/knowledge`. Glossary gains *Document Vault*.

## 5. Generated (rail label; route `/alfred/artifacts`)

One destination listing everything the LLM generated and you kept: reports,
decks, infographics, wiki pages, zettels — filterable by kind and status
(draft/reviewed). **Boundary (owner decision 2026-10-22): Generated holds
kept outputs only. Raw saved answers stay inside their conversation thread;
"save to notes" writes a Note, not a Generated item. Conversations is the
list of threads; Generated is the list of things those threads produced
that are worth keeping.** The Notebook's "In this notebook" panel stays
(scoped view); Generated is the global list.

**Label (owner decision 2026-10-22):** the rail says "Generated" — plain
word, passes the trunk test, and matches the four-way origin split (wrote /
uploaded / pointed / generated). The glossary pins it.

**Discovery (owner decision 2026-10-22):** when a run's draft is kept, the
run panel shows a one-line "Kept in Generated" link. The connection is
taught at the moment of keeping; no tour, no banner, no extra chrome.

Route: `/alfred/artifacts`, rail entry between Notebook and People.
Zettels appear here filtered by kind=zettel; the Notebook's sources pane
links to its zettels.

## 6. URL/redirect policy

- Every removed route gets a permanent redirect in its page file (Next.js
  `redirect()` at render, not middleware — the paths are few and known).
  Redirects drop query params: source and document ids have no global
  surface anymore, so `/alfred/sources?id=x` lands on the Notebook list
  bare rather than half-mapping an id to a page that no longer renders it.
- `featureRoutes` in navigation.ts drops entries whose destinations die,
  gains the renames.
- E2E specs that visit removed paths update to the new homes
  (`smoke.spec.ts`, `neuralflow.spec.ts`).
- **Phone bar (owner decision 2026-10-22):** Assistant, Today, Notebook,
  More (4 targets + More). DESIGN.md §8's "Today, Work, Library, Assistant,
  More" line is updated in the same change. 44px targets preserved.

## 7. What this change does NOT do

- No data model changes except Learning's deletion.
- No visual redesign of kept screens beyond label changes.
- No new components beyond the Artifacts list and the Notebook "Add
  sources" control (both reuse existing kits).

## 8. Interaction states for the new and renamed surfaces

Per DESIGN.md §10, the full cycle is mandatory. What the user SEES:

```
FEATURE            | LOADING              | EMPTY                          | ERROR                    | SUCCESS                 | PARTIAL
-------------------|----------------------|--------------------------------|--------------------------|-------------------------|------------------------------
Artifacts list     | Skeleton rows, list  | "Nothing generated yet.        | Labelled status card:    | Rows appear as saved    | Filter counts reflect what
                   | shape, not spinner   | Generate a report or deck      | what failed + Retry      | (author sees own write) | loaded, never dressed whole
                   |                      | from a Notebook." + link       |                          |                         |
Notes              | Editor skeleton      | "Write your first page."       | Status card w/ Retry;    | Autosave line: "Saved"  | Unsaved edits marked
                   |                      | (composer focused)             | draft preserved          |                         | "Unsaved"
Notebook           | Row-level spinner    | "No sources yet. Add a URL,    | Per-source failure row:  | Source appears w/       | Per-source readiness:
Add sources        | per upload           | YouTube link, or file."        | "Couldn't fetch X" +     | readiness state shown   | Reading... / Ready / Failed
                   |                      | (3 controls, one row each)     | Retry                    |                         | (reuses existing field)
```

Empty states name the action that fills them (§10.1). The Add-sources
control reuses the existing `readiness` field — no new state model. Every
failure renders the labelled status card (§10); nothing crashes, nothing
pretends success.

## 9. Mid-review additions (owner directives, 2026-10-22)

- **The "New dossier" document-picker checkbox list goes away.** Creating a
  notebook is naming it; documents get attached in the Notebook's Sources
  pane afterward (NotebookLM pattern). `CreateDossierForm` loses the picker;
  `listAttachableDocuments` serves the Notebook's Add-sources control.
- **Notes is its own page** (decision 1, §1): human-written notes live at
  `/alfred/notes`; human-uploaded documents in the Vault; LLM-generated
  artifacts in Artifacts; sources tracked in the Notebook itself.

## 10. NOT in scope

- Notes/Generated/Notebook screen visual redesigns — label changes only; the
  screens already exist and follow DESIGN.md.
- Mobile layout rework beyond the phone-bar composition decided above.
- The legacy `/apps/*` preview registry retirement (DESIGN.md §15 debt,
  separate change).
- Merging People/Companies into one Relationships surface — considered;
  deferred (two distinct daily jobs).
- Any change to the agent roster, skills contract, or run model.

## 11. What already exists (reuse, do not reinvent)

- `featureRoutes` + `destinationForPath` in `src/lib/navigation.ts` — the
  redirect/alias map this change edits.
- `PageHeader`/`Section` shell; workspace kit `Screen`, `Panel`, `Empty`,
  `Status` — every new surface composes from these.
- The Notebook's 3-pane layout and `readiness` field — Add-sources reuses
  them; no new state model.
- The draft keep/discard flow (`DraftControls`) — gains only the
  "Kept in Generated" link line.
- The existing e2e helpers and smoke spec structure.

---

## Implementation Tasks
Synthesized from this review's findings. Each task derives from a specific
finding above. Run with Claude Code or Codex; checkbox as you ship.

- [ ] **T1 (P1, human: ~4h / CC: ~20min)** — navigation.ts — rewrite the
  destinations list to the 15-entry rail (§2); drop Sources, Wiki, Learning,
  Spending, Opportunities, Focus; add Notes and Generated; update
  featureRoutes and the phone-bar composition (Assistant, Today, Notebook,
  More).
  - Surfaced by: Pass 1 — rail definition; Pass 5 — phone bar hardcoded in
    DESIGN.md §8.
  - Files: src/lib/navigation.ts, src/components/shell/mobile-nav.tsx,
    DESIGN.md (§8 line), tests/unit/navigation.test.ts
  - Verify: pnpm typecheck && pnpm test; rail renders 15 entries.
- [ ] **T2 (P1, human: ~1h / CC: ~10min)** — redirects — one page-file
  redirect per removed route: /alfred/sources → /alfred/dossiers,
  /alfred/wiki → /alfred/knowledge, /alfred/learning → /alfred/notes,
  /command-center/spending → /command-center/briefing?tab=spending,
  /command-center/opportunities → People, /neuralflow/focus → Work,
  /alfred/notebook → /alfred/notes. Query params dropped.
  - Surfaced by: §6 URL/redirect policy; Pass 6 — param-drop rule.
  - Files: the six removed route page.tsx files
  - Verify: curl each old path → 307 to the new one.
- [ ] **T3 (P0, human: ~2d / CC: ~45min)** — delete Learning entirely:
  teaching domain, /alfred/learning route, learning agent tools and
  capability mappings, evals, tests, mobile-bar entry, plus one forward-only
  drop migration for the teaching tables (decision C).
  - Surfaced by: §3b — owner directive, data policy decision.
  - Files: src/domains/teaching/, src/app/(workspace)/alfred/learning/,
    src/domains/agents/ (tool registrations), drizzle migration, tests/
  - Verify: pnpm typecheck && pnpm test && pnpm build; grep finds no
    "learning" references outside the drop migration.
- [ ] **T4 (P2, human: ~3h / CC: ~20min)** — Notes at /alfred/notes: move the
  notes surface from /alfred/notebook, retitle to Notes, compose the empty
  state ("Write your first page." + focused composer).
  - Surfaced by: Decision 1 — four-way origin split; §8 states table.
  - Files: src/app/(workspace)/alfred/notebook/ → notes/
  - Verify: pnpm e2e notebook legs pass at the new path.
- [ ] **T5 (P2, human: ~4h / CC: ~25min)** — Generated at /alfred/artifacts:
  the global kept-outputs list, filterable by kind and status; empty state
  per §8; zettels as a kind filter.
  - Surfaced by: §5 — Generated definition and boundary; §8 states.
  - Files: new src/app/(workspace)/alfred/artifacts/page.tsx,
    src/domains/knowledge/queries (artifact list query)
  - Verify: renders artifacts from the workspace; empty state names
    Notebook generation.
- [ ] **T6 (P2, human: ~2h / CC: ~15min)** — Notebook Add-sources control in
  the Sources pane (URL / YouTube / file / pick from Vault), reusing the
  readiness field; remove the CreateDossierForm document picker (§8
  directive).
  - Surfaced by: §3a; §8 mid-review directive.
  - Files: src/app/(workspace)/alfred/dossiers/[dossierId]/notebook/,
    create-dossier-form.tsx
  - Verify: add a URL → readiness states visible; create form is name-only.
- [ ] **T7 (P3, human: ~30min / CC: ~5min)** — glossary + spec sync: DESIGN.md
  §14 gains Notebook/Notes/Document Vault/Generated, retires Dossier;
  §15 records the /dossiers URL debt; docs/axiom-product-spec.md §8.6 and the
  nav sections updated in the same change.
  - Surfaced by: Pass 5 — glossary; §4 renames.
  - Files: DESIGN.md, docs/axiom-product-spec.md, docs/glossary.md
  - Verify: docs review; no retired term used as a destination label.
- [ ] **T8 (P3, human: ~1h / CC: ~10min)** — e2e reconciliation: smoke.spec.ts
  and neuralflow.spec.ts legs updated to the new homes; navigation unit test
  updated.
  - Surfaced by: §6 — e2e specs visit removed paths.
  - Files: tests/e2e/smoke.spec.ts, tests/e2e/neuralflow.spec.ts,
    tests/unit/navigation.test.ts
  - Verify: pnpm e2e.

---

## Design Review Completion Summary

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | DESIGN.md current; UI scope = full IA       |
  | Step 0               | initial 3/10; gaps: homes for removed       |
  |                      | functions, URL policy, glossary conflicts   |
  | Pass 1  (Info Arch)  | 4/10 → 9/10 (content model, boundary)       |
  | Pass 2  (States)     | 5/10 → 9/10 (full state table added)        |
  | Pass 3  (Journey)    | 7/10 → 9/10 (keep-time Generated link)      |
  | Pass 4  (AI Slop)    | 8/10 → 9/10 ("Generated" label)             |
  | Pass 5  (Design Sys) | 8/10 → 9/10 (phone bar re-composed)         |
  | Pass 6  (Responsive) | 8/10 → 9/10 (redirect param-drop rule)      |
  | Pass 7  (Decisions)  | 8 resolved, 0 deferred                      |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (5 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 0 proposed (all work is in-plan tasks)      |
  | Approved Mockups     | 0 (designer had no OpenAI key)              |
  | Decisions made       | 8 added to plan                             |
  | Decisions deferred   | 0                                           |
  | Overall design score | 3/10 → 9/10                                 |
  +====================================================================+
```

Decisions made (all owner-confirmed 2026-10-22):
1. Four-way origin split: Notes / Document Vault / Generated / Notebook.
2. Notes is its own page at /alfred/notes.
3. Generated holds kept outputs only; saved answers stay in Conversations.
4. Rail label "Generated" (not "Artifacts").
5. Keep-time "Kept in Generated" link for discovery.
6. Phone bar: Assistant, Today, Notebook, More.
7. Skills stays on the rail.
8. /dossiers URL kept with the Notebook label; Learning tables dropped now;
   Vault shows uploaded documents only (wiki pages in Generated).

## GSTACK REVIEW REPORT


| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Outside Review | codex (skipped — no OpenAI key for designer; outside voices not run) | Independent 2nd opinion | 0 | skipped | not run |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 3/10 → 9/10, 8 decisions |

**OUTSIDE COVERAGE:** codex, design phase, skipped (not run this session; no OpenAI credential for the design binary, outside voices step not reached). Native review completed with findings resolved in-plan.

**VERDICT:** DESIGN CLEARED — eng review required (required gate; no eng review exists for this plan).

NO UNRESOLVED DECISIONS
