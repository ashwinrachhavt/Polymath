# architecture.md — The system map

**Purpose:** what exists, where it lives, and how the parts connect. Written from
the code, not from the plan. When this file and the code disagree, the code is
right and this file is the bug.

Read this before changing anything that crosses a domain boundary. For a
single-domain change, the domain's own `schema.ts` and `queries.ts` are enough.

## Shape

A Next.js 16 App Router modular monolith on Vercel, with Neon Postgres +
pgvector as the system of record. One deployment, one database, one identity
provider.

```text
Browser
  └─ React Server Components (reads) + Server Actions (first-party mutations)
       └─ src/app/            routes, layouts, actions, route handlers
            └─ src/domains/    one folder per domain: schema, commands, queries
                 └─ src/integrations/  provider adapters
                      └─ src/lib/      auth, errors, db, idempotency, telemetry
```

Flows point one way: `app → domains → integrations → lib`. `lib` imports nothing
from `domains`. `integrations` never import UI. UI never queries another domain's
tables.

## Directory map

```text
src/app/          routes, layouts, RSC pages, server actions, route handlers
  (workspace)/    authenticated shell: command-center, neuralflow, alfred, shared
  api/v1/         route handlers (see Request boundaries)
src/components/   presentation only; no data access
  products/       per-surface components (command-center, neuralflow, alfred)
  shell/          launcher, nav, shared chrome
src/domains/      18 domains, each owning its tables (skills added 2026-10: ASH-200;
                  learning deleted 2026-10-22, tables dropped in migration 0235)
src/integrations/ embeddings, extraction, firecrawl, notion, object-store,
                  search, wiki, zettels
src/lib/          auth, clerk, db, problems, list-params, safe-fetch, zip, capability-config
src/db/           migrations, schema root
src/proxy.ts      request proxy
extensions/chrome/  browser companion
eve/              agent definitions and tools (alfred, specialist)
scripts/          seed, initdb, local-search, hooks
tests/            integration and unit suites
```

There is **no `src/workflows/`**. Long work is not yet a first-class subsystem;
see Known gaps.

## The domains

Each owns its tables. A domain exposes queries (reads) and commands (writes).
Cross-domain work goes through a command or an event, never a join.

| Domain | Owns | Notes |
|---|---|---|
| `identity` | users, workspaces, memberships, role definitions, resource grants | Tenancy lives here. Clerk identity resolves to a workspace server-side. |
| `capture` | captures, capture_proposals | The inbox queue. `processing_state` drives it. |
| `work` | tasks, projects, spaces, boards, board_columns, task_dependencies, task_links | One task model. Boards are saved views. |
| `focus` | focus_sessions, daily_outcomes | Focus is tied to one task; outcomes feed briefing. |
| `calendar` | calendars, events, event_attendees, event_links, recurrence_templates, scheduler_preferences, schedule_proposals, follow_ups | |
| `knowledge` | documents, document_*, artifacts, artifact_versions, artifact_links, dossiers, sources, claims, embeddings, wiki_pages, working_drafts, zettel_proposals, context_manifests | The largest domain. Extraction, search, the knowledge base, notes, exports. |
| `crm` | contacts, companies, contact_*, party_*, account_person_links, opportunities, opportunity_* | Canonical people and organisations. |
| `conversations` | threads, messages, thread_checkpoints, correspondence | Agent and human conversation records. |
| `agents` | agent_profiles, agent_runs, agent_steps, agent_questions, tool_calls, tool_invocations, memory_items, runtime_executions, runtime_signals, spend_* | Profiles, runs, memory, spending. |
| `actions` | action_proposals, action_attempts, action_policies, action_reviews, action_revisions, reviewed_assertions | The review pipeline for external writes. |
| `gamification` | reward_definitions, reward_ledger, user_progress, daily_snapshots | Rewards. Model unselected. |
| `integrations` | external_accounts, external_identities, provider_observations, sync_cursors, connection_attempts, webhook_inbox, api_clients, triggers, integration_catalog | Provider state and credentials references. Access tiers live on `external_accounts.access_tier` (enforced in the gateway, per connection, read live per call); `integration_catalog.access_tiers` mirrors `PROVIDER_TIERS` as connect-screen display data. Provider reads route through the generic registry (`src/domains/integrations/reads/generic.ts`): a provider slice is a spec — endpoint, query template, list path, item mapper — not gateway code. |
| `audit` | audit_events, outbox_events | Append-only audit plus the transactional outbox. |
| `applications` | application_preparations, application_materials, application_snapshots, dossiers | Application packages. Overlaps knowledge; see Known gaps. |
| `opportunities` | opportunities, opportunity_deadlines, opportunity_extensions, opportunity_links, opportunity_stage_history | Pursuit stage machine. |
| `spending` | spending_policies, spending_reservations, spend_settlements, model_rate_cards, api_client_usage | Budget capture and settlement. |

## The data spine

Every owned table carries:

```text
id           uuid primary key
workspace_id uuid not null            -- tenant scope
created_by   uuid
updated_by   uuid
created_at   timestamptz
updated_at   timestamptz
archived_at  timestamptz
version      integer default 1        -- optimistic concurrency
```

Rules that hold everywhere:

- **Tenancy is server-resolved.** `AuthContext` carries the workspace; a client
  never supplies an owner or workspace ID.
- **Writes are idempotent.** Every mutation takes a request UUID recorded in
  `request_receipts`.
- **Stale writes are rejected**, not merged. A write carries the version it
  expects.
- **Audit and outbox are written in the same transaction as the change.** A
  change with no audit row did not happen.
- **Invariants live in the database** — `unique`, `check`, `not null`, partial
  indexes — not only in application code.
- **JSONB is for provider payloads and flexible metadata only.** Anything
  queried, sorted, or constrained gets a column.

## Request boundaries

| Kind | Lives in | For |
|---|---|---|
| React Server Component | `src/app/**/page.tsx`, layouts | Every read. Compose the view model server-side, in parallel, bounded. |
| Server Action | `src/app/**/actions.ts` | First-party mutations. |
| Route Handler | `src/app/api/v1/**/route.ts` | `/api/v1`, webhooks, SSE, signed files, health, workflow kickoff. Nothing else. |

A server action runs, in order: authenticate → resolve `AuthContext` → parse
input → idempotency and expected-version checks → domain command → audit and
outbox in the same transaction → invalidate cache tags.

Never call this app's own HTTP endpoints from the server. Never hold a
transaction open across a provider call.

Existing route handlers:

```text
/integrations/callback        webhook receiver
/v1/captures                  capture creation
/v1/documents/[id]/extract    document extraction
/v1/documents/[id]/preview    preview rendering
/v1/dossiers, /v1/dossiers/[id]/generate
/v1/drafts, /v1/drafts/[id]/[decision]
/v1/exports/manifests/[id]/packet, /v1/exports/packets/[id]
/v1/files                     upload
/v1/research/company
/v1/runs, /v1/runs/[id]{,/cancel,/messages,/retry}
/v1/search
```

## The capture pipeline

The mechanism the product depends on, and the one most likely to be extended.

```text
createCapture (idempotent, dedupes URL-only)
   → captures row: kind, source, raw_payload (immutable), text|url|blob
   → processing_state = 'unprocessed'
   → partial index captures_inbox_idx on (workspace_id, created_at)
        where state in ('unprocessed','classifying')

classifier (NOT YET BUILT)
   → 'classifying'
   → capture_proposals row: kind ∈ {task,note,project,contact,company,
                                   opportunity,reference,event,discard}

owner accepts
   → convertCaptureToTask (or equivalent)
   → creates canonical record + sets converted_type/converted_id/converted_at
   → audit in the same transaction
```

`capture_proposals` carries a status enum and a reason. The proposal is the
suggestion; conversion is the mutation.

## Agent execution

All agent execution goes through the `AgentEngine` contract in
`src/domains/agents/engine.ts`: `start` / `signal` / `cancel` / `resume`.

- `src/domains/agents/eve-driver.ts` implements it against the Eve agent runtime.
- `src/domains/agents/event-bridge.ts` records rounds, tool calls, questions,
  usage, messages, waits, and closures. It is the only writer of run events.
- `src/domains/agents/runtime-persistence.ts` persists the timeline.
- A run captures its policy snapshot at start: profile, model, tools, budget. It
  cannot escape it.
- Tool availability is bounded by profile, feature, account, policy, and run.
  The full catalog is never handed to a model.
- Retries create new runs; terminal states are immutable; tool results are
  append-only.
- Spend is reserved before paid work and settled after.
- External writes become action proposals, never a direct tool call.

Agent definitions live in `eve/alfred/agent/` and `eve/specialist/agent/`, with
tools in `agent/tools/`. Authored tools: `documents_search`, `tasks_read`,
`web_fetch`, `web_search`, `wiki_ingest`, `wiki_lint`, `wiki_read`.

Provider tools are not authored: they arrive through the `polymath-gateway` MCP
connection (`eve/alfred/agent/connections/polymath-gateway.ts`) as
`polymath-gateway__gmail_search`, `…__gmail_read_thread`, and `…__gmail_send`,
and every call is authorized and recorded by `POST /api/mcp`. The agent holds no
provider credential and has no other route to one.

Domain code never imports a model SDK or a workflow platform directly. Only
`AgentEngine` implementations do.

## Integrations

Adapters, one folder each, no UI imports.

| Adapter | Path | Selected by |
|---|---|---|
| Document extraction | `src/integrations/extraction/` | `DOCLING_SERVE_URL` → Docling; else `REDUCTO_API_KEY` → Reducto; else `LLAMAPARSE_API_KEY` → LlamaParse; else PDF text layer |
| Web search | `src/integrations/search/` | `SEARCH_PROVIDER` or `SEARXNG_URL`; also firecrawl, brave, tavily, exa, parallel, ai-gateway-<provider>, duckduckgo |
| Crawl/scrape | `src/integrations/firecrawl/` | `FIRECRAWL_API_URL` + key |
| Embeddings | `src/integrations/embeddings/` | — |
| Object storage | `src/integrations/object-store/` | — |
| Notion | `src/integrations/notion/` | — |

Local development runs Docling, SearXNG, and a full self-hosted Firecrawl stack
in `compose.yaml` (`make search-up`). The deployed app cannot reach those
containers, so it uses the hosted adapters. Provider resolution is in code, not
in configuration branching at call sites.

## Long work

Long work never lives inside a request. Today it creates a row and either uses
`after()` (post-response, same function) or is driven by the docent extraction
lease.

`document_extractions` carries a 10-minute lease with a `pid:uuid` claim token, so
a process that outlives its lease cannot overwrite a newer attempt.

The outbox dispatcher in `src/domains/audit/outbox.ts` implements claim, complete,
fail, stranded-lease recovery, and batch dispatch, with `for update skip locked`
and lease-token fencing.

## Known gaps

Recorded here so an agent does not build on a foundation that is not there.

1. **The outbox consumer is new and narrow.** `b3821b9` added
   `src/app/api/internal/outbox/route.ts` and
   `src/domains/audit/outbox-handlers.ts`. It dispatches document extraction
   behind a gate. Everything else that writes an outbox event still has no
   handler, so those rows commit and stay pending.
2. **`src/workflows/` does not exist.** `coding.md` names it as a module
   boundary and marks it as not yet created.
3. **Capture enrichment is built, including the `classifying` state.**
   `enrichment-handler.ts`, `enrichment-lease.ts`, `url-content-handler.ts` and
   `zettel-generation.ts` exist and are registered in `outboxHandlers()`.
   `processingState` is set to `'classifying'` while the model call is in
   flight (`enrichment-handler.ts:218`, `url-content-handler.ts:76`) and to
   `'enriched'` on completion. `capture_proposals` rows are written by the
   enrichment handler (`enrichment-handler.ts:400`) and by `jev-classify.ts`,
   which restricts the kinds it may propose to task, contact, note and discard
   (`jev-classify.ts:31`). The earlier version of this
   file claimed none of that was built; it was wrong on every count. Note when
   grepping: the states appear as object values (`processingState: "enriched"`)
   as well as string literals, so a quoted-literal grep under-reports.
4. **DEFECT, dated 2026-10-26 — delete this entry when it is fixed; it is a
   bug, not a design choice.** Enrichment runs and fails at the Jev step. The
   registry entry for `jev` is `enabled: true` (owner decision, 2026-10-25)
   while `tryJevTriage` catches only
   `JevDisabledError`/`JevUnconfiguredError`. `jevClassifier` throws
   `QuotaExhaustedError` when `JEV_MONTHLY_INPUT_TOKENS` is unset, and that
   escapes as a redeliverable error instead of falling back. The result is a
   redelivery loop with the deterministic tiers' work discarded — not a missing
   feature, so do not read this entry as "enrichment is unbuilt". Two comments
   in `enrichment-handler.ts` still claim the registry "ships disabled".
   Tracked as ingestion-repair 4.6; remove this entry in the PR that makes
   `QuotaExhaustedError` fall back.
5. **Extraction runs inside the request** via `after()` in
   `src/app/api/v1/files/route.ts`. A long document can outlive the function
   duration on the default plan.
6. **`docs/axiom-product-spec.md` was rewritten on 2026-10-19** and the Notion
   copy carries the same content by hand. They will drift; check both.
7. **Two doc filenames keep the old Axiom prefix** for link stability:
   `docs/axiom-product-spec.md` and `docs/axiom-nextjs-neon-plan.md`. Content
   says Polymath.

## Non-negotiables

An agent changing the system must not break these:

- A second task table, a second note store, or a second approval pipeline.
- A query without `workspace_id` in scope.
- A mutation without an idempotency key.
- An external write that bypasses `action_proposals` and Reviews.
- A model output that grants itself authority.
- A transaction held open across a provider call.
- A `catch` that logs and continues.
- A migration edited after it shipped.
