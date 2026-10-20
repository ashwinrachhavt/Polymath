# reference.md — Commands, environment, and gotchas

**Purpose:** the lookup table. Commands that exist, variables that select
behaviour, paths that matter, and the traps that have already cost time.

Read the relevant section instead of grepping the repo or reading `package.json`.

## Commands

| Command | Does | Notes |
|---|---|---|
| `make check` | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | The gate. One definition of passing, same as CI. |
| `make install` | `pnpm install` | |
| `make dev` | `pnpm dev` | Next dev server. |
| `make e2e` | `pnpm e2e` | Playwright. Needs a dev server or `E2E_BASE_URL`. |
| `make search-up` | Starts SearXNG + Firecrawl | First run generates a local SearXNG secret. Loopback-bound. |
| `make search-down` | Removes the search stack | |
| `make search-logs` | Tails search stack logs | |
| `pnpm db:migrate` | Applies migrations | |
| `pnpm db:generate` | Generates a migration from schema changes | |
| `pnpm db:studio` | Drizzle Studio | |
| `pnpm check:migrations` | Migrations consistency check | Part of review, not `make check`. |
| `pnpm seed:personal` | Seeds companies | |
| `pnpm companion:pair` | Pairs the browser companion | |

Individual pieces of `make check`, when you need one of them alone:

```bash
pnpm lint
pnpm typecheck        # next typegen && tsc --noEmit
pnpm test             # vitest run --passWithNoTests
pnpm build
```

## Environment

Set in `.env.local` for development. `.env.example` is the reference; never
commit a real value.

| Variable | Selects | Absent means |
|---|---|---|
| `DATABASE_URL` | App Postgres | App cannot start |
| `TEST_DATABASE_URL` | Integration suite database | Integration tests skip. **Never** point at the app database. |
| `DOCLING_SERVE_URL` | Local Docling extraction provider | Falls through to LlamaParse |
| `LLAMAPARSE_API_KEY` | Hosted extraction provider | Falls through to PDF text layer |
| `SEARCH_PROVIDER` | `searxng`, `brave`, `tavily`, `exa`, `duckduckgo` | Resolution order applies |
| `SEARXNG_URL` | Private metasearch endpoint | Falls back to keyed providers |
| `FIRECRAWL_API_URL` | Firecrawl endpoint | Crawl unavailable |
| `FIRECRAWL_API_KEY` | Firecrawl auth | |
| Clerk keys | Identity | App cannot authenticate |
| Object storage keys | File blobs | Uploads unavailable |

Provider selection is **in code**, in `src/integrations/*/provider.ts`. Reading
the env var alone does not tell you which adapter is active; read the resolver.

## Where things live

| Looking for | Path |
|---|---|
| A route | `src/app/(workspace)/<surface>/.../page.tsx` |
| A mutation | `src/app/**/actions.ts` |
| An HTTP endpoint | `src/app/api/v1/**/route.ts` |
| A domain's tables | `src/domains/<domain>/schema.ts` |
| A domain's writes | `src/domains/<domain>/commands.ts` |
| A domain's reads | `src/domains/<domain>/queries.ts` |
| Provider adapters | `src/integrations/<provider>/` |
| Auth and tenancy | `src/lib/auth.ts`, `src/lib/clerk.ts` |
| Error shape | `src/lib/problems.ts` |
| Database client | `src/lib/db.ts` |
| Migrations | `src/db/migrations/NNNN_name.sql` |
| Agent definitions | `eve/<agent>/agent/agent.ts` |
| Agent tools | `eve/<agent>/agent/tools/*.ts` |
| Design tokens | `src/app/globals.css` (`:root`, `.dark`, `@theme inline`) |
| Browser companion | `extensions/chrome/` |
| Integration tests | `tests/integration/` |

## Gotchas

Each of these has already caused wasted time. They are not hypothetical.

### Turbopack stale CSS

A long-running dev server does not always reload `globals.css`. The symptoms is a
page rendering the **old** tokens with no error anywhere. Restart the dev server
before debugging the CSS.

### `after()` throws outside a request

`after()` from `next/server` throws when called outside a request scope — for
example, from a directly-invoked handler in a test. The pattern in
`src/app/api/v1/files/route.ts` is to catch and fall back to fire-and-forget.
Do not assume `after()` is always available.

### Migration numbering is not sequential

Migrations are grouped by area (`00xx`, `01xx`), not one counter. Read the
highest number in the group you are extending, not the highest overall.

### CSS modules do not compile

`*.module.css` does not work under the current Turbopack CSS rule in
`next.config.ts`. Use a plain stylesheet with a feature prefix (`nf-`, `loop-`).

### `shadcn --accent` is not the brand colour

shadcn's `--accent` is a subtle hover surface. The brand cyan lives on
`--primary` and `--ring`. Re-pointing `--accent` floods every hover state.

### The em dash is banned in user-visible strings

Every heading, label, body string, quote, caption, button, and alt text. Hyphen
for compounds and ranges. A figure with no source is a hairline placeholder or an
omitted row, never a typed dash and never a fabricated `0`.

### Browsers must run headless

Every automated browser check runs headless. Never open a visible Chrome window.
This is an owner instruction, not a default.

### Donors are frozen

`~/Projects/{command-center,alfred,neuralflow}` are read-only references. Read
them to understand history or to migrate a behaviour. Never edit them.

### The two spec copies

`docs/axiom-product-spec.md` and the Notion page are both maintained by hand.
When they disagree, say so rather than silently following one. The Notion page
holds the product narrative; the repo copy is reviewed in PRs.

### Two filenames keep the old prefix

The repository, package, and docs were renamed Axiom → Polymath in `d9bd844`.
Two files were left with the old prefix so existing links resolve:
`docs/axiom-product-spec.md` and `docs/axiom-nextjs-neon-plan.md`. Their content
says Polymath. Do not "fix" the filenames without updating every link.

## Testing

- **Unit and integration:** `pnpm test` (vitest).
- **Integration suites need real Postgres.** `TEST_DATABASE_URL` must point at a
  disposable database; the suite truncates it before running.
- **Invariants that matter** — idempotency, version conflicts, audit atomicity,
  tenancy, vector and full-text search — are tested against real Postgres, never
  a mock.
- **Provider contract tests use sanitised fixtures.** Never a live call in CI,
  never real contacts, mail, résumés, tokens, or screenshots of private data.
- **Playwright covers journeys, not pages:** capture → task → briefing → focus →
  completion; note → search → cite; proposal → approve → confirm.
- **No assertions on markup snapshots.** They pass while the UI is broken and
  fail when it is merely changed.

## Adding things

| Adding | Where |
|---|---|
| A route | `src/app/(workspace)/<surface>/<name>/page.tsx` |
| A server action | A sibling `actions.ts`, never inline in a page |
| A table | The owning domain's `schema.ts` plus a migration |
| A provider | `src/integrations/<name>/` behind a `provider.ts` resolver |
| A background job | A domain command plus an outbox event; see `architecture.md` Known gaps first |
| A shadcn component | `pnpm dlx shadcn@latest add <name>`, then restyle through tokens |
| An env var | `.env.example` with a comment naming what selects it |

## Reading order for a new contributor

1. `CLAUDE.md`
2. `agents/README.md`
3. `agents/product.md` — what we are building
4. `agents/coding.md` — how code is written
5. `agents/architecture.md` — the system map
6. `agents/agent.md` — the agent org and how work flows
7. The ticket
8. The one spec section the ticket names
