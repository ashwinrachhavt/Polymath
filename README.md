# Axiom

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

`src/domains/*` currently hold one README each naming what the domain owns —
no empty schema, no interface with one implementation. Fill a domain in when it
has real tables and commands.

Boundaries are enforced by review, not by tooling. A domain owns its tables; UI
never queries another domain's tables directly. Flows point one way:
`app → domains → integrations → lib`.

## Docs

`docs/` owns product and architecture; `agents/` owns stance. Both are loaded by
default through `CLAUDE.md`. Where they disagree, `agents/*` wins, then
`CLAUDE.md`, then skill defaults.
