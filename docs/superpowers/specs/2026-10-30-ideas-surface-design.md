# Ideas surface, vault rebuild, and the removal of cards, areas, and sittings

**Date:** 2026-10-30
**Status:** approved design, not yet implemented
**Supersedes:** the sitting-centred creation flow in `2026-10-29-polymath-zettel-sitting-design.md`

---

## Why

Ideas are the product's atomic unit but they have no home. They live at
`/polymath/knowledge/zettels`, buried under a document-vault prefix, reachable
only through a tab strip. Around them sits machinery the owner has now decided
against: a spaced-repetition card system, a declared-areas system, and a
multi-stage "sitting" that turns zettel creation into a multi-pane workspace.

The owner's direction (2026-10-30):

- Zettels become a top-level surface named **Ideas**.
- Cards and Areas are deleted completely, including their tables.
- Sittings are deleted. Creation is one loop: capture from Inbox, generate
  proposals, accept, the idea appears in Ideas.
- The Document Vault is rebuilt to the mockup: a flat row list, not a folder
  grid, and no tab strip.
- Linking between ideas survives — it is the point of the surface.
- The websocket server proposed mid-review is **not** added; existing NDJSON
  streaming already covers every realtime need this product has.

Success looks like: a person captures something in Inbox, it becomes an idea,
they see it in Ideas beside their other ideas, and they can follow the links
between them. Nothing in the UI mentions cards, areas, mastery, recall,
sittings, or a learning loop.

---

## Scope

### In scope

1. A new `/polymath/ideas` destination with a rebuilt card UI.
2. Removal of the cards subsystem (routes, domain, schema, tests).
3. Removal of the areas subsystem (routes, domain, schema, tests).
4. Removal of the sittings subsystem (routes, components, domain).
5. A rebuilt Document Vault at `/polymath/knowledge` matching the mockup.
6. Redirect bridges so no existing link 404s.

### Out of scope

- No websocket/socket.io server. `src/app/api/v1/runs/[runId]/stream` and the
  sitting create-stream precedent already stream NDJSON with durable replay;
  zettel creation reuses that transport.
- No URL change for the vault: it stays at `/polymath/knowledge`.
- No change to the capture pipeline, the outbox, or `requestZettelGeneration`.
- No change to document extraction, classification, parties, or obligations.

---

## Part 1 — The Ideas surface

### Route layout

```
/polymath/ideas                  the collection (cards | table | timeline | dictionary)
/polymath/ideas/new              direct capture — saveIdeaAction, already built
/polymath/ideas/[id]             one idea: claim, evidence, tags, links, edit
/polymath/ideas/proposals        proposed ideas awaiting acceptance
```

Sittings have no successor route. Their capability — multi-source generation
with staged progress — is replaced by Inbox generation (Part 4).

### Card component

The mockup's card carries five things: a title in medium weight, one sentence
of claim, tag pills, a muted attribution line ("from <source>"), and a date.
Nothing else. No mastery badge, no recall state, no progress bar.

Split out of the current 467-line `writing-surface.tsx`:

| File | Responsibility |
| --- | --- |
| `components/polymath/ideas/idea-card.tsx` | One card. Pure props, no fetching. |
| `components/polymath/ideas/idea-grid.tsx` | Cards/table/timeline/dictionary switch |
| `components/polymath/ideas/idea-links.tsx` | The link strip between related ideas |
| `components/polymath/ideas/idea-editor.tsx` | Moved from `zettels/idea-editor.tsx` |

Each unit has one job and takes plain data, so the card is testable without a
database and the grid can change layout without touching card internals.

### Linking

`listSuggestedLinks`/`suggested-links-strip.tsx` survive as the link surface.
A link is a stored relation between two artifacts; the strip renders inbound
and outbound links on a single idea and a quiet count on the card. No new link
model is introduced — this is the existing one, moved.

### Navigation

`src/lib/navigation.ts` gains one destination and loses none:

```ts
{
  href: "/polymath/ideas",
  label: "Ideas",
  purpose: "Your ideas, each with its evidence.",
  icon: Lightbulb,
  group: "polymath",
}
```

It sits directly after Notes, before Document Vault — writing, then thinking,
then sources.

---

## Part 2 — Deleting cards and areas

### Removed files

```
src/app/(workspace)/polymath/knowledge/cards/            (page, review, actions, controls, learning-path-form)
src/app/(workspace)/polymath/knowledge/areas/            (page, actions, controls)
src/app/(workspace)/polymath/knowledge/ideas/            (superseded by /polymath/ideas)
src/domains/knowledge/cards.ts
src/domains/knowledge/card-queries.ts
src/domains/knowledge/areas.ts
src/domains/knowledge/area-queries.ts
src/domains/knowledge/area-resolve.ts
src/domains/knowledge/learning-paths.ts                  (cards-only: sole importer is cards/actions.ts)
tests/integration/cards.test.ts
tests/integration/areas.test.ts
```

### Schema and migration

Three tables drop: `cards`, `card_reviews`, `areas`. Any `area_id` column on
another table drops with its constraint. The migration is
`src/db/migrations/0224_drop_cards_and_areas.sql`, numbered after `0223`.

The migration is destructive and irreversible. It runs only after the code no
longer reads these tables, so a deploy order of "code first, migration second"
leaves no window where the app queries a dropped table.

### Partial removals

These files keep their purpose and lose only their card/area branch:

- `src/domains/integrations/reads/generic.ts` — the `cards` read kind
- `src/components/chat/record-links.ts` — the card link builder
- `src/components/chat/surface-card.tsx` — the card surface variant
- `src/domains/supervisor/respond.ts` — the card reference
- `tests/unit/generic-read.test.ts`, `tests/e2e/proposal-batches.spec.ts` —
  the card assertions

### Definition of done

`grep -rn "knowledge/cards\|knowledge/areas\|card-queries\|area-queries" src eval eve tests`
returns only the migration file and the changelog entry.

---

## Part 3 — Removing sittings

### Removed files

```
src/app/(workspace)/polymath/knowledge/zettels/          (page, session/*, actions)
src/app/api/v1/polymath/sittings/                        (create-stream route)
src/components/polymath/zettels/writing-surface.tsx
src/components/polymath/zettels/workspace-shell.tsx
src/components/polymath/zettels/sitting-store.ts
src/components/polymath/zettels/decomposition-panel.tsx
src/components/polymath/zettels/creation-stream-reducer.ts
src/components/polymath/zettels/session-rail.tsx
src/components/polymath/zettels/ambient-panel.tsx
src/domains/knowledge/sittings.ts
src/domains/knowledge/sitting-run.ts
src/domains/knowledge/sitting-events.ts
```

### Preserved deliberately (verified, not assumed)

- `src/domains/knowledge/decomposition.ts` — backs the going sitting pipeline
  *and* the staying "Propose zettels" button on a document's review page. It
  loses its sitting entry points and keeps the document ones.
- `src/domains/knowledge/continuation.ts` — sitting-run and sitting-events
  import it, but so do the project notebook page, the run page, the API-keys
  panel, and `use-chat-stream`. It is a general continuation-cursor helper, not
  sitting machinery; deleting it with sittings would break chat streaming.

Documents drop `zettel_sitting_id`-style columns if any exist; the
`zettel_sitting_cards` table drops with sittings.

### This is the largest cut

32 files and roughly 400 references. What remains of zettel creation is:
capture in Inbox → `generateZettelsAction` queues an outbox job → proposals
appear → accept → the idea exists. That is the loop the owner asked for.

---

## Part 4 — Vault rebuild

`/polymath/knowledge` becomes the mockup's screen:

- Title "Document Vault", one line of purpose.
- A search field and a quiet count: "6 items · 2 need attention".
- Rows: icon, title, `type · size · timestamp`, status pill on the right.
- Status vocabulary is the pill wheel already in `globals.css`: neutral for
  read, `working` amber for needs-review, `danger` for failed.
- One trailing line of reassurance ("Only exceptions get a word here.").

The tab strip (Documents · Ideas · Sittings · Cards · Areas) is deleted. The
detail view at `?doc=<id>` survives unchanged — it is the review workbench and
the source of the "Propose zettels" button.

Folder browsing: the folder tile grid is removed with the rebuild. Folders
remain in the data model; they surface as a filter in the search field rather
than as a separate drill-down. If folder drill-down proves necessary, it
returns as a row-level affordance, not a grid.

---

## Part 5 — Redirect bridges

Every removed URL maps to its successor in `featureRoutes`
(`src/lib/navigation.ts`), the mechanism `/polymath/notebook` → `/polymath/notes`
already uses:

```ts
"/polymath/knowledge/zettels": "/polymath/ideas",
"/polymath/knowledge/zettels/session": "/polymath/ideas",
"/polymath/knowledge/ideas": "/polymath/ideas",
"/polymath/knowledge/cards": "/polymath/ideas",
"/polymath/knowledge/areas": "/polymath/ideas",
```

Cards and Areas map to Ideas rather than to a 404 because a person who
bookmarked the old review queue should land where ideas now live, not on an
error. The vault prefix itself is unchanged.

---

## Part 6 — Testing

| Layer | Test |
| --- | --- |
| Unit | `idea-card.test.tsx` — renders title, claim, tags, attribution, date; no mastery/recall chrome |
| Unit | navigation — `/polymath/ideas` resolves to Ideas; each removed path resolves through its bridge |
| Unit | `decomposition.ts` keeps its document entry point after sitting code is removed |
| Integration | new idea from Inbox capture reaches `/polymath/ideas` (the full loop) |
| Integration | vault row list renders counts and status pills |
| Deleted | `cards.test.ts`, `areas.test.ts`, and the card assertions in `generic-read`, `proposal-batches` |

The e2e journeys that drive sitting text verbatim are deleted with sittings;
they cannot be repaired into the new flow without inventing behaviour.

---

## Risks and their handling

**Irreversible data loss.** Dropping `cards`, `card_reviews`, and `areas`
destroys any existing rows. The owner accepted this explicitly. The migration
lands after the code change so no deploy window queries a dropped table.

**Sitting removal is wide.** ~400 references across 32 files. Handled by
removing routes first, then components, then domain modules, running `tsc`
between stages so every dangling import surfaces immediately rather than at the
end.

**Inbox becomes the only entry point for generated ideas.** If the outbox is
down, no ideas are created. `generateZettelsAction` already fails with a
readable message rather than hanging; the review-page "Propose zettels" button
stays as the second path.

**Folder drill-down disappears.** Folders stay in the model but lose their UI.
This is a deliberate simplification matching the mockup; it is called out here
so it is not discovered as a surprise.
