# Axiom

Personal command center and knowledge operating system. A Next.js 16 modular
monolith on Vercel with Neon Postgres as the system of record.

## Requirements

- Node 24
- pnpm 12 (`corepack enable`)

## Commands

```bash
pnpm dev        # dev server, Turbopack
pnpm check      # lint + typecheck + test + build — run this before a PR
```

CI (`.github/workflows/ci.yml`) runs the same four steps on every push to `main`
and every pull request. Vercel deploys each branch as a preview via its GitHub
integration; nothing is deployed from CI.

## Layout

```text
src/app/          routes, layouts, server actions, route handlers
src/components/   presentation; no data access
src/domains/      one folder per domain: schema, commands, queries, policies, events
src/integrations/ composio, firecrawl, object storage, model providers
src/workflows/    durable workflow definitions, steps, signals
src/lib/          auth, errors, idempotency, telemetry, validation
```

Boundaries are enforced by review, not by tooling. A domain owns its tables; UI
never queries another domain's tables directly. Flows point one way:
`app → domains → integrations → lib`.

## Docs

`docs/` owns product and architecture; `agents/` owns stance. Both are loaded by
default through `CLAUDE.md`. Where they disagree, `agents/*` wins, then
`CLAUDE.md`, then skill defaults.
