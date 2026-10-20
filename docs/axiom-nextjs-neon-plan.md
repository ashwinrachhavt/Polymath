# Polymath Technical Specification

**Revision:** 2026-10-19. Supersedes the Next.js/Neon consolidation plan.
**Scope:** a web application that runs locally. Desktop and mobile are out of
scope. Product behaviour is owned by [axiom-product-spec.md](axiom-product-spec.md).

---

# 1. Shape

One web application, run on the operator's machine. No hosted multi-tenant
service, no desktop shell, no mobile client.

```text
Browser
  └─ Next.js app (App Router)
       ├─ RSC reads, Server Actions, Route Handlers
       ├─ Postgres 17 + pgvector          system of record
       ├─ Local Docker services          heavy processing
       │    docling, searxng, firecrawl
       └─ Outbox + dispatcher            durable work
```

Everything runs on one machine by default. There is no dependency on a cloud
provider for the core loop.

# 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Next.js 16, App Router | RSC reads, Server Actions, one deployable |
| Language | TypeScript, `strict: true` | |
| Database | Postgres 17 + `vector` | One engine locally and in any hosted copy |
| ORM | Drizzle | Typed schema, forward-only SQL migrations |
| Identity | Clerk | Server-resolved; clients never supply identity |
| Styling | Tailwind v4 + shadcn + Radix | Tokens in one stylesheet |
| Heavy processing | Local Docker Compose | Docling, SearXNG, Firecrawl |
| Object storage | Local filesystem in dev | Binaries only; metadata stays in Postgres |

# 3. Local and hosted posture

The product must run with `docker compose up -d && pnpm db:migrate && pnpm dev`.

| Concern | Local default | Hosted option |
|---|---|---|
| Database | `pgvector/pgvector:pg17` on loopback | Any Postgres 17 with pgvector |
| Extraction | Docling container | LlamaParse, selected by env |
| Search | SearXNG container | Keyed provider, selected by env |
| Crawl | Firecrawl container | Hosted Firecrawl |
| Identity | Clerk dev instance | Clerk production |
| Blobs | Local directory | Any S3-compatible store |

Provider selection lives in `src/integrations/*/provider.ts`. Presence of an env
var chooses the adapter; no component branches on a provider.

# 4. Repository shape

```text
src/app/          routes, layouts, RSC pages, server actions, route handlers
src/components/   presentation only
src/domains/      one folder per domain: schema, commands, queries
src/integrations/ provider adapters
src/lib/          auth, errors, db, idempotency, telemetry
src/db/           schema root, migrations
agents/           agent-facing instruction set
eve/              agent definitions and tools
scripts/          seed, initdb, local-search, hooks
```

Flow is one-way: `app → domains → integrations → lib`. `lib` imports nothing from
`domains`. `integrations` never import UI. UI never queries another domain's
tables.

# 5. The three pillars in code

The pillars are presentation boundaries over one record set.

| Pillar | Route family | Domains it presents |
|---|---|---|
| Command Center | `/command-center/*` | `capture`, `crm`, `conversations`, `actions`, `spending` |
| NeuralFlow | `/neuralflow/*` | `work`, `focus`, `gamification`, `calendar` |
| Alfred | `/alfred/*` | `knowledge`, `learning`, `agents` |

Shared, unprefixed: `/reviews`, `/activity`, `/settings`.

A record is never duplicated across a pillar. Command Center's correspondence
links to the same person Alfred's note cites.

# 6. Data contracts

Every owned table carries:

```text
id           uuid primary key
workspace_id uuid not null
created_by   uuid
updated_by   uuid
created_at   timestamptz
updated_at   timestamptz
archived_at  timestamptz
version      integer default 1
```

Rules, non-negotiable:

- **Tenancy is server-resolved.** A client never supplies `workspace_id` or a user id.
- **Every mutation takes an idempotency UUID**, recorded in `request_receipts`.
- **Stale writes are rejected** by expected version, never silently merged.
- **Audit and outbox commit in the same transaction** as the change.
- **Invariants live in the database** — `unique`, `check`, `not null`, partial indexes.
- **JSONB is for provider payloads only.** Anything queried gets a column.
- **No transaction is held open across a provider call.** Reserve, commit, call, settle.

## 6.1 Core resources

Twelve, in business language, plural nouns, no prefixes, no verbs.

`workspaces`, `users`, `memberships`, `sources`, `notes`, `claims`, `cards`,
`links`, `tasks`, `sessions`, `areas`, `runs`.

Added for Command Center, because they carry lifecycles the twelve cannot express
as a column:

`correspondence` (planned → drafted → sent → received, plus failed and cancelled),
`follow_ups` (open, done, cancelled, superseded), `contacts`, `companies`,
`observations`.

Everything else is a capability over these. A stone is a session outcome. A
shard is a claim on the reward ledger. A proposal is a pending mutation over any
resource. A dossier is a bounded set of sources.

# 7. Request boundaries

| Kind | Lives in | For |
|---|---|---|
| RSC | `src/app/**/page.tsx` | Every read. Compose server-side, in parallel, bounded. |
| Server Action | `src/app/**/actions.ts` | First-party mutations. |
| Route Handler | `src/app/api/v1/**/route.ts` | `/api/v1`, webhooks, SSE, signed files, health, queue drain. |

Server action order: authenticate → resolve context → parse input → idempotency
and version checks → domain command → audit and outbox in transaction → invalidate
cache tags.

Never call this app's own HTTP endpoints from the server. Never let long work live
inside a request.

# 8. Execution model

Long work never runs inside a request.

- The **transactional outbox** records intent in the same transaction as the change.
- A **dispatcher** claims due rows under a lease (`for update skip locked`), runs
  the handler outside any transaction, and completes or fails with a fencing token.
- A stranded lease is recoverable. A worker that lost its lease cannot complete.
- Document extraction uses its own lease with a claim token, so an outliving
  process cannot overwrite a newer attempt.

**Current state.** `src/app/api/internal/outbox/route.ts` and
`src/domains/audit/outbox-handlers.ts` dispatch document extraction behind a gate.
Every other outbox event has no handler yet, so those rows commit and stay
pending. Extending the handler table is phase-0 work.

**Local scheduler.** A local process drains the queue. In development this is a
loop started by `pnpm dev` or a compose service; there is no cloud cron dependency.

# 9. Local processing

Heavy work runs in containers, chosen by the user's hardware.

| Service | Image | Purpose | Cost |
|---|---|---|---|
| `db` | `pgvector/pgvector:pg17` | System of record, test database | Required |
| `docling` | `quay.io/docling-project/docling-serve` | Document extraction | ~2 GB models on first run |
| `searxng` | `searxng/searxng` | Private metasearch | Light |
| `firecrawl` + stack | `ghcr.io/firecrawl/firecrawl` and dependencies | Crawl and scrape | Heavy; optional |

`make search-up` starts the search stack. The heavy stack is opt-in, because a
laptop may not have the memory and the product must still work without it.

**Degradation is explicit.** If Docling is not running, extraction falls through
to the PDF text layer or LlamaParse and says which was used. If Firecrawl is not
running, crawl is unavailable and says so. Nothing silently pretends to work.

# 10. Agents

All execution goes through the `AgentEngine` contract: `start`, `signal`,
`cancel`, `resume`. Domain code never imports a model SDK.

| Role | Owns | Authority |
|---|---|---|
| Supervisor | Planning, delegation, stopping | No tools; cannot widen its own scope |
| Curator | Classification, enrichment, dedupe, tagging | Read sources, write proposals |
| Researcher | Source gathering, claim extraction, citation | Read public sources, write cited claims |
| Writer | Drafting from the library | Read library, write draft notes |

**Invariants.**

- Delegation narrows authority. A sub-agent's tool set is verified as a subset of
  its delegator's, and tested.
- A run captures its policy snapshot at start and cannot exceed it.
- Tool availability is bounded by profile, feature, account, policy, and run.
- External writes become proposals. No tool calls a mutating endpoint directly.
- Spend is reserved before paid work and settled after.
- Visible summaries, decisions, evidence, and redacted arguments persist. Hidden
  chain-of-thought never does.

**MCP servers** are tool sources with per-agent allowlists, never a general escape
hatch. **Skills** are versioned Markdown plus typed tool schemas, pinned to runs.

# 11. Integrations

| Adapter | Path | Selected by |
|---|---|---|
| Docling | `src/integrations/extraction/` | `DOCLING_SERVE_URL` |
| LlamaParse | same | `LLAMAPARSE_API_KEY` |
| PDF text layer | same | fallback |
| SearXNG | `src/integrations/search/` | `SEARCH_PROVIDER=searxng` or `SEARXNG_URL` |
| Brave, Tavily, Exa, DuckDuckGo | same | `SEARCH_PROVIDER` |
| Firecrawl | `src/integrations/firecrawl/` | `FIRECRAWL_API_URL` + key |
| Composio | connected accounts | account records |
| Object storage | `src/integrations/object-store/` | `BLOB_*` |

Provider records carry request identity, observed time, verification label, cost,
and freshness. Distinguish no-match, quota exhausted, rate limited, access denied,
unavailable, and suppressed. Never bypass a quota with another account.

# 12. Coding standard

## The ladder

Stop at the first rung that holds.

1. Does this need to exist? Speculative need means do not build it.
2. Does it already exist here? Reuse the helper, type, or pattern.
3. Does the platform do it? Postgres constraints, `timestamptz`, CSS, Server
   Actions, RSC streaming.
4. Does an installed dependency do it?
5. Can it be one line?
6. Only now, the minimum code that works.

## Rules

- One file per concept, named for what it does. No `utils.ts`, no barrel re-exports.
- No interface with one implementation. No factory for one product.
- Comments state **why** and the non-obvious constraint, never what.
- No commented-out code, no ownerless TODOs, no section banners.
- Deleted lines are progress. The diff is the smallest correct one.
- No new dependency without a stated reason in the commit message.
- No `catch` that logs and continues.
- Boundary behaviour is explicit: provider down is a labelled status card, not a
  crash and not an empty list claiming success.

## Naming

Business domain language. Plural nouns, no prefixes, no verbs. Foreign keys as
`<singular>_id`. A junction table is named for the relationship it represents.
REST paths follow the names: `POST /v1/sources`, `GET /v1/notes?area=`.

## Frontend

- Client components are leaves. `"use client"` at the top of a page is a smell.
- Server state is fetched on the server. A `useEffect` fetching what the RSC
  already had is a bug.
- State Postgres already holds is not duplicated in React.
- Every data surface ships loading, empty, filtered-empty, partial, stale, error,
  offline, permission-denied, and success.
- Never render an incomplete result as whole.

## Anti-patterns

Repository or service layers wrapping plain ORM calls; DTOs mirroring models;
`any` in a signature; boolean traps; an abstraction introduced for a second caller
that does not exist; a helper used once, inlined; validation only in the client;
retry without idempotency; a feature flag with no date to die; a second task
store; a second note store; a second approval pipeline.

# 13. Testing

- Test behaviour through the public interface, not internals.
- Non-trivial logic leaves **one runnable check**. Branching, looping, parsing,
  money, security, and tenancy are non-trivial.
- Invariants run against **real Postgres**, never a mock: idempotency, version
  conflicts, audit atomicity, tenancy, search.
- Provider contract tests use sanitised fixtures. Never a live call in CI, never
  real contacts, mail, résumés, or tokens.
- Playwright covers journeys: capture → inbox → task; correspondence → follow-up;
  note → search → cite; session → stone.
- No markup snapshots. They pass while the UI is broken.
- Every fixed bug gains the check that would have caught it.

# 14. Performance

Budgets are tests: initial route JS under 180 KB gzip, LCP under 2.5 s p75, INP
under 200 ms p75, one composition boundary for the briefing, virtualise above 200
rows, paginate every server collection.

Query hygiene: no N+1; index every column a hot query filters on; keep
transactions short.

# 15. Privacy and recovery

- Distinguish public source content, private library, sensitive answers, derived
  output, operational records, and secrets.
- Cloud models receive only configured data classes under an explicit budget.
- Real sources, exports, tokens, and private screenshots stay out of git and out
  of fixtures.
- Local binding and CORS are not authentication. Validate origin and host.
- Secrets live in the environment or OS keychain; records hold references only.
- Archive handling rejects unsafe paths and symlinks, enforces extraction limits.
- URL fetchers restrict protocols, private and link-local destinations, redirects,
  and response size.
- Audit is append-only through normal operations, with redacted diffs. A local
  administrator can still alter storage; never promise absolute immutability.
- Backups capture a consistent snapshot, a manifest of referenced artifacts,
  schema and config metadata, and separately recoverable keys. Restore is verified
  in isolation with execution disabled, and consumed grants never revive.

# 16. What must not break

- A second task store, note store, or approval pipeline.
- A query without `workspace_id` in scope.
- A mutation without an idempotency key.
- An external write bypassing proposals.
- A model output granting itself authority.
- A transaction open across a provider call.
- A `catch` that logs and continues.
- A migration edited after it shipped.

# 17. Open technical decisions

- Queue drain mechanism in the local process: dev-server loop, compose service, or
  a separate `pnpm worker`.
- The expertise scoring algorithm and its data model.
- The stone intensity algorithm.
- Which tools each sub-agent may hold.

---

# Appendix — Withdrawn

These were in the previous revision and are no longer the direction:

- FastAPI, SQLAlchemy, Alembic, SQLite/FTS5.
- `apps/{api,web,worker}` as the repository layout.
- A desktop client, a mobile client, or a hosted multi-tenant service.
- Docker Compose as a deployment target rather than a local development
  convenience.
- Cloud cron as the only way to drain the queue.
