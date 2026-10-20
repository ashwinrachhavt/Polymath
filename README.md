# Polymath

Personal command center and knowledge operating system. A Next.js 16 modular
monolith on Vercel with Neon Postgres as the system of record.

## Requirements

- Node 24 (`.node-version` — `fnm use`, `nvm use`, or `asdf install`)
- pnpm 12 (`corepack enable`)

## Setup

```bash
cp .env.example .env    # fill in DATABASE_URL; Clerk keys are optional
pnpm install
pnpm exec playwright install chromium   # once, for the journey tests
```

`DATABASE_URL` (Neon) is required by `src/lib/db.ts` and `drizzle.config.ts`.
Clerk is optional: without `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
`CLERK_SECRET_KEY` the app runs unsigned-in, and `/sign-in` 404s. Both or
neither — see `src/lib/clerk.ts`.

## Commands

```bash
pnpm dev        # dev server, Turbopack
pnpm check      # lint + typecheck + test + build — run this before a PR
pnpm e2e        # Playwright journeys (builds and starts the server)
make check      # the same gate, by the name agents/engineering.md uses

pnpm db:generate   # diff the domain schemas into a migration
pnpm db:migrate    # apply migrations to DATABASE_URL
pnpm db:studio     # browse the data
```

Migrations are forward-only and reviewed before they run. Never edit one after
it has been applied; generate a new one. `0000_extensions.sql` is a custom
migration — drizzle-kit does not emit `CREATE EXTENSION`, so it is written by
hand and runs first because `embeddings.embedding` is a `vector`.

Integration tests need `TEST_DATABASE_URL` set to a database with the
migrations applied:

```bash
createdb axiom_test
DATABASE_URL="postgresql://localhost/axiom_test" pnpm db:migrate
TEST_DATABASE_URL="postgresql://localhost/axiom_test" pnpm test
```

CI (`.github/workflows/ci.yml`) runs `check` and `e2e` on every push to `main`
and every pull request. Vercel deploys each branch as a preview via its GitHub
integration; nothing is deployed from CI, so the first deploy needs the repo
imported to a Vercel project once.

## Layout

```text
src/app/          routes, layouts, server actions, route handlers
src/components/   presentation; no data access
src/domains/      one folder per domain: schema, commands, queries, policies, events
src/integrations/ composio, firecrawl, object storage, model providers
src/workflows/    durable workflow definitions, steps, signals
src/lib/          auth, errors, idempotency, telemetry, validation
tests/            unit, integration, contract, migration, e2e
```

`src/domains/*` each own a `schema.ts` with their tables. Commands, queries,
and policies land per domain as features arrive — the schema is real, the
behaviour is not yet.

Boundaries are enforced by review, not by tooling. A domain owns its tables; UI
never queries another domain's tables directly. Flows point one way:
`app → domains → integrations → lib`.

## Docs

`docs/` owns product and architecture; `agents/` owns stance. Both are loaded by
default through `CLAUDE.md`. Where they disagree, `agents/*` wins, then
`CLAUDE.md`, then skill defaults.

### Adding migrations in parallel

Reserve a four-digit SQL prefix with the other active lanes before generating.
A prefix is a name, not execution order: append to `meta/_journal.json` in merge
order and choose `when` greater than **every** existing entry. Rebase on current
main immediately before merge and re-check. Never renumber published timestamps
or change applied SQL to fix a collision; use a new repair migration instead.

Run `pnpm check:migrations origin/main` after fetching. CI compares against the
PR target (or the previous main commit), rejects changed history, duplicate
prefixes/tags, missing/orphan SQL, and new checkpoints that Drizzle would skip.
Legacy out-of-order history is intentionally preserved, not silently repaired.

Drizzle snapshots are a schema-generation baseline, not the migration ledger.
The existing snapshot chain is incomplete. Do not resolve parallel snapshot
collisions by blindly unioning JSON: generate serially on current main, review
the SQL against existing migrations, and append one journal entry. The guard
does not prove snapshot/schema equivalence or apply anything to a database.

## Knowledge enrichment state machine

Documents move through an enrichment pipeline after their text exists
(source capture or upload triggers `extractAndEmbedAfterText`; transcription
providers hook in too). The `document_enrichment` table records one row per
document and stage with status `pending | running | succeeded | failed |
skipped`, attempt count, and the last error.

Stages run in order, and the line stops at the first failure so no stage
runs on missing input:

1. **extract** — mirrors the latest `document_extractions` run (visible
   `skipped` with the reason when no text is extractable; `failed` with the
   provider error on failure).
2. **embed** — chunks and embeds the extraction through `embedExtraction`.
3. **zettels** — proposes zettel cards through `proposeZettels`.
4. **link** — embeds every accepted zettel card into the semantic graph
   (`embedArtifact`, owner_type `artifact`), making the card discoverable
   from `relatedNotes`. Link re-runs on later passes because accepting a
   zettel after the first pass adds a card the last pass never saw;
   embedding is idempotent per card.

Failures stay visible in the table (never silently lost) and
`retryDocumentEnrichment` re-runs the line, skipping already-succeeded
stages. A stage marked `skipped` is a durable decision (e.g. no extractable
text) and is not retried.

## Notes tab: categories, kanban and editor ergonomics

Notes and zettels carry category tags on `artifacts.tags` (normalized
lowercase, deduped, audited through `note.tags_changed`). The notebook
sidebar filters by tag with chips, and a layout toggle switches between the
paged list and a kanban that groups the matching notes into one column per
tag (`?layout=kanban`). The note page opens with a Notion-style properties
block (type, tags, created, updated, version) whose tags edit inline against
the artifact's optimistic version.

Editor ergonomics follow the Notion/Tiptap pattern: `space` on an empty
paragraph opens the Notebook AI menu (the result is always a reviewable
draft, never silent text), `/` opens block commands, and `[[` links a note
or zettel by title. Below the body, Matuschak-style panels show References
(outlinks) and Links to this note (backlinks) with the linking context
excerpt, plus the semantic Related by meaning panel.
