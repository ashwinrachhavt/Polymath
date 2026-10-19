# Polymath Next.js and Neon Consolidation Plan

**Status:** Proposed implementation architecture  
**Date:** 2026-10-10  
**Target:** Next.js 16, Vercel, Neon Postgres, Clerk, AI SDK, Composio, Firecrawl, and an Eve-compatible durable workflow adapter

## Executive decision

Build a TypeScript modular monolith. Use Next.js App Router for UI, Server Components for reads, Server Actions for first-party mutations, Route Handlers for APIs/webhooks/SSE/files, Drizzle plus SQL migrations for Neon, pgvector for semantic retrieval, object storage for binaries, and durable workflows for long-running jobs.

Do not retain Polymath as a proxy over donor backends. Do not translate FastAPI endpoints one-for-one. Consolidate by domain, preserve proven invariants, and retire duplicate concepts.

## Reviewed implementation

### Command Center

- 14 workspace destinations and 141 frontend components.
- 219 HTTP endpoint declarations.
- More than 70 Postgres tables across 40 Alembic migrations.
- 151 automated test files.
- CRM, work queue, artifacts, documents, writing, conversations, agents, research, memory, spending, reviewed actions, application preparation, and browser companion.
- Proven idempotency, optimistic versions, immutable versions, audit, reviews, owner derivation, agent questions, reconciliation, and spending reservations.

### NeuralFlow

- 20 pages, 72 Route Handlers, 32 Prisma models, 10 enums, and 89 React components.
- No discovered automated test files.
- Boards/tasks/todos, calendar, scheduler, focus/Pomodoro, notes, embeddings, AI enrichment, reports, projects, meetings, knowledge graph, flashcards, quizzes, and gamification.

### Consolidation conclusion

Command Center supplies safety and operational invariants. NeuralFlow supplies productivity interactions, focus, learning, and rewards. Polymath combines both in one canonical model and simpler deployment topology.

## Target topology

```text
Browser
  │
  ▼
Vercel / Next.js 16
  ├─ App Router UI (RSC + client islands)
  ├─ Server Actions
  ├─ Route Handlers (API, webhooks, SSE, files)
  ├─ Domain modules and policy logic
  ├─ AgentEngine (AI SDK + Eve adapter)
  ├─ Composio and Firecrawl adapters
  └─ Durable workflows
          │
          ├─ Neon Postgres + pgvector
          ├─ Object storage
          ├─ Clerk
          ├─ Composio
          ├─ Firecrawl
          └─ model providers
```

A modular monolith fits because records are highly connected, cross-domain transactions matter, and separate services would recreate the FastAPI/Celery/Redis burden being removed. Typed module boundaries and transactional outbox events preserve a future service-extraction path.

## Repository layout

```text
src/
  app/
    (auth)/
    (workspace)/
      briefing/ inbox/ work/ alfred/ knowledge/
      relationships/ opportunities/ reviews/ activity/ settings/
    api/
      v1/ webhooks/ runs/[runId]/events/ files/[fileId]/
  components/
    shell/ ui/ data/ editor/ agents/ work/ reviews/
  domains/
    identity/ capture/ work/ calendar/ focus/ knowledge/
    crm/ opportunities/ applications/ agents/ actions/
    integrations/ learning/ gamification/ audit/ spending/
  db/
    schema/ migrations/ queries/ transactions/
  integrations/
    composio/ firecrawl/ object-store/ models/
  workflows/
    definitions/ steps/ signals/
  lib/
    auth/ errors/ idempotency/ telemetry/ validation/
scripts/
  import-command-center/ import-neuralflow/ import-alfred/ reconcile/
tests/
  unit/ integration/ contract/ e2e/ migration/
```

Each domain owns schema declarations, commands, queries, policies, and events. UI code calls domain interfaces and does not query another domain's tables directly.

## Request boundaries

### Server Components

Use for authenticated initial reads and composed view models. Briefing executes bounded domain reads in parallel. Never call internal Polymath HTTP endpoints from the same server process.

### Server Actions

Use for owner-initiated first-party mutations:

1. Authenticate Clerk.
2. Resolve internal user/workspace/membership.
3. Parse Zod input.
4. Apply idempotency and expected-version checks.
5. Call a domain command.
6. Write audit/outbox records in the same transaction.
7. Invalidate affected cache tags.

Do not use for webhooks, external clients, long jobs, or large uploads.

### Route Handlers

Use for stable `/api/v1`, provider webhooks, SSE run events, signed file URLs, health/readiness, and workflow kickoffs. Return stable problem-detail error codes.

### Background work

Imports, crawls, extraction, embeddings, agent runs, email scheduling, reports, and application generation create job/run rows and durable workflows. They never remain inside one long request.

## Neon foundation

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Use UUID identifiers, `timestamptz`, native constraints for invariants, JSONB only for provider/flexible metadata, and partial indexes for active queues.

Common mutable tenant record:

```text
id uuid primary key
workspace_id uuid not null
created_by uuid
updated_by uuid
created_at timestamptz not null
updated_at timestamptz not null
archived_at timestamptz
version integer not null default 1
```

## Canonical schema

### Identity

- `users`: internal identity mapped to Clerk.
- `workspaces`: tenant boundary.
- `memberships`: user/workspace role and status.
- `user_preferences`: timezone, week start, appearance, accessibility.
- `api_clients`: paired browser companion or machine clients.

All database access receives `AuthContext { userId, workspaceId, role }`. Composite indexes begin with `workspace_id` where appropriate.

### Reliability primitives

- `request_receipts`: idempotency key, request hash, stored response.
- `audit_events`: append-only actor/action/subject summaries.
- `outbox_events`: transactional async events.
- `webhook_inbox`: verified provider-delivery dedupe and processing state.

### Work

- `projects`, `spaces`, `tasks`, `task_dependencies`, `task_links`.
- `boards`, `board_columns`, `saved_views`.
- `daily_outcomes`, `focus_sessions`, `captures`.

Canonical task states: `INBOX`, `BACKLOG`, `READY`, `IN_PROGRESS`, `WAITING`, `DONE`, `CANCELLED`, `ARCHIVED`.

Boards are saved visual configurations over tasks. They do not own duplicate tasks.

### Calendar

- `calendars`, `events`, `event_attendees`, `event_links`.
- `scheduler_preferences`, `schedule_proposals`.

External identity is unique on `(external_account_id, provider_object_id)`. Keep provider etags/versions for safe updates.

### Knowledge

- `artifacts`, immutable `artifact_versions`.
- `working_drafts`, `recovery_copies`.
- `files`, `documents`, `document_extractions`, `document_decisions`.
- `sources`, `claims`, `artifact_links`, `embeddings`.
- `flashcard_decks`, `flashcards`, `flashcard_reviews`.
- `quizzes`, `quiz_questions`, `quiz_attempts`.

Combine Postgres full-text with pgvector. Keep source offsets so semantic results open exact evidence.

### CRM and opportunities

- `companies`, `contacts`, `contact_observations`.
- `correspondence`, `follow_ups`.
- `opportunities`, `roles`, `applications`.
- `application_snapshots`, `application_preparations`, `application_materials`.
- `imports` and row-level import results.

### Agents

- `agent_profiles`, `threads`, `messages`, `thread_checkpoints`.
- `agent_runs`, `agent_steps`, `tool_calls`, `agent_questions`, `run_artifacts`.
- `memory_items`, `memory_revisions`, `memory_reviews`.
- `model_rate_cards`, `spending_policies`, `spending_reservations`.

Do not persist hidden chain-of-thought. Persist visible summaries, decisions, evidence, redacted tool arguments/results, and status.

### Integrations and actions

- `integration_catalog`, `external_accounts`, `sync_cursors`, `triggers`.
- `action_policies`, `action_proposals`, `action_revisions`.
- `action_reviews`, `action_attempts`, `provider_observations`.

Unique constraints cover provider delivery IDs, canonical action dedupe keys, and scoped external account identities.

### Gamification

- `reward_definitions`.
- append-only `reward_ledger`.
- `user_progress` cached projection.
- `daily_snapshots`.

Inventory derives from the ledger; avoid one table per collectible class unless behavior truly differs.

## Capability mapping

| Donor capability | Polymath module | Mapping | Disposition |
|---|---|---|---|
| CC Briefing/dashboard/work queue | `briefing`, `work` | RSC composition and deterministic priority | Rebuild/simplify |
| CC companies/contacts | `crm` | Drizzle records and inspector UI | Port behavior |
| CC jobs/opportunities/leads | `opportunities` | generic opportunity + role specialization | Merge |
| CC tasks/spaces | `work` | canonical task/context | Merge |
| NeuralFlow boards/tasks/todos | `work` | boards become saved views | Merge |
| NeuralFlow calendar/scheduler | `calendar` | events + proposals | Port |
| NeuralFlow Pomodoro | `focus` | timer island + durable sessions | Port |
| CC artifacts/drafts | `knowledge` | artifact/version/draft/recovery | Port invariants |
| NeuralFlow notes/embeddings/graph | `knowledge` | artifacts + links + retrieval | Merge |
| CC documents/classification/PDF | `knowledge.documents` | durable workflows | Port |
| NeuralFlow flashcards/quizzes | `learning` | reviewed derived content | Port |
| NeuralFlow gamification | `gamification` | reward ledger | Simplify |
| CC conversations/checkpoints | `agents.threads` | record-scoped continuity | Port |
| CC runs/events/questions | `agents.runtime` | workflows + SSE | Port invariants |
| NeuralFlow AI routes/orchestrator | `agents.skills` | typed skills | Rewrite |
| CC reviewed actions/Composio | `actions`, `integrations` | proposal/review/attempt machine | Port invariants |
| CC research | `research` | Firecrawl primary adapter | Rewrite adapter |
| CC spending | `spending` | reservation and settlement | Port |
| CC browser companion | `companion` | stable `/api/v1` pairing/commands | Port late |
| CC application preparation | `applications` | workflows and versions | Port late |
| NeuralFlow reports | `reviews` | weekly projection + Alfred synthesis | Merge |
| NeuralFlow meetings | `calendar`, `knowledge` | event + linked notes/actions | Merge |
| Alfred/Eve unknown | importer + `AgentEngine` adapter | inventory required | Discovery blocker |

## Agent runtime

```ts
interface AgentEngine {
  start(input: StartRunInput): Promise<{ runId: string }>;
  signal(runId: string, signal: RunSignal): Promise<void>;
  cancel(runId: string, actor: AuthContext): Promise<void>;
  resume(runId: string): Promise<void>;
}
```

Default implementation uses AI SDK model/tool primitives. `EveAgentEngine` implements the same contract if Eve is the workflow platform. Domain code never imports Eve directly.

Tool layers:

1. Domain read tools.
2. Domain preparation tools.
3. Composio external tools.
4. Firecrawl research tools.
5. Browser-companion commands.

Tool availability is bounded by profile, feature, account, policy, and run. Never expose the universal provider catalog to every model call.

### Run algorithm

1. Validate objective and record references.
2. Capture profile, model, tools, policy, and budget snapshots.
3. Reserve spend.
4. Start durable workflow and append `run.started`.
5. Execute bounded model/tool steps with timeouts and cancellation checks.
6. Suspend on `agent_questions` when input is missing.
7. Create action proposals for external writes.
8. Persist artifacts and final summary.
9. Settle spend and append terminal event.
10. Create optional reviewed memory suggestions.

### Streaming

`GET /api/runs/:runId/events?after=<sequence>` provides SSE. Events have monotonically increasing per-run sequence numbers. Reconnection resumes from the last sequence; Postgres remains authoritative.

## Composio

### Accounts

- Generate Connect Links server-side.
- Map internal user/workspace to stable Composio user IDs.
- Persist connected account ID, toolkit, provider identity, alias, scopes summary, status, and selection—not tokens.
- Support multiple accounts and explicit account selection for writes.
- Revoke upstream and reconcile uncertain outcomes.

### Execution

- Instantiate Composio server-side only.
- Request feature-specific tools.
- Wrap each tool with Zod validation, risk classification, policy, redaction, timeout, idempotency, and audit.
- Models choose account aliases, not arbitrary provider IDs.

### Webhooks

1. Read raw body.
2. Verify HMAC signature and timestamp.
3. Insert `webhook_inbox` by delivery ID.
4. Return quickly.
5. Resolve trigger, environment, workspace, user, and account asynchronously.
6. Advance cursors, update local mirrors, and start bounded workflows.

Separate Composio projects for development, staging/preview, and production.

## Firecrawl

```ts
interface WebResearchProvider {
  search(input: SearchInput): Promise<SearchResult[]>;
  scrape(input: ScrapeInput): Promise<ScrapedPage>;
  map(input: MapInput): Promise<MappedUrl[]>;
  crawl(input: CrawlInput): Promise<{ jobId: string }>;
  getCrawl(jobId: string): Promise<CrawlState>;
}
```

Use search for discovery, scrape for known URLs, map for site structure, and crawl only for bounded approved multi-page jobs. Store canonical URL, title, fetched time, hash, provider request ID, extraction format, and text/blob pointer. Deduplicate by URL plus content hash. Preserve source offsets and cite sources in synthesis.

Bound result count, page count, depth, domains, timeouts, and daily workspace credits. Models cannot expand crawl boundaries without policy authorization.

## Security

- Clerk `proxy.ts` establishes authentication, but resource authorization occurs within domain boundaries.
- Webhooks authenticate with signatures, not browser sessions.
- Companion clients use allowed machine/OAuth tokens or paired short-lived credentials.
- Secrets remain in server environment variables and never enter telemetry.
- External emails, web pages, files, and issues are untrusted prompt data.
- Prompt content cannot alter policy or tool authorization.
- External writes require policy and approval regardless of model instruction.
- Define retention for raw email, webhook bodies, model payloads, and failed tool results.

## Caching and performance

- Authenticated mutable data is dynamic by default.
- Cache stable catalogs with `use cache`, `cacheLife`, and cache tags.
- Use immediate tag updates for read-your-own-write and revalidation for background changes.
- Never place secrets or unbounded user data in shared caches.
- Query Neon directly from server code; do not call internal HTTP APIs.
- Use pooled/serverless Neon connections and short transactions.
- Never keep database transactions open across provider calls.

## Vercel execution

Ordinary functions handle RSC reads, CRUD actions/routes, webhook verification/enqueue, signed URLs, and bounded SSE.

Durable workflows handle agent runs, approvals, crawls, extraction, embeddings, scheduled delivery, imports, weekly reports, and application generation.

Hobby cron is only a coarse reconciliation sweep, not a precise scheduler.

## Free-plan posture

| Service | Role | Response |
|---|---|---|
| Vercel Hobby | web and functions | remain under function duration; no commercial assumptions |
| Neon Free | canonical Postgres | monitor storage and compute; allow scale-to-zero |
| Clerk Hobby | authentication | sufficient for personal beta; separate environments deliberately |
| Composio Hobby | tools and triggers | enforce budgets below provider caps |
| Firecrawl | research | bound credits, pages, depth, and freshness caching |

Upgrade before 70% sustained capacity or when SLAs, backups, collaboration, precise schedules, or commercial usage demand it.

## Migration

### Discovery gate

- Obtain and inventory Alfred/Eve.
- Export row counts, enum distributions, FK orphans, duplicates, blob sizes, and active jobs.
- Record Clerk instances and external-account mappings.
- Freeze canonical enum and identity maps.

### Framework

Each importer implements `extract`, `normalize`, `load`, and `verify` and writes:

```text
migration_source
source_table
source_id
source_version_or_hash
target_table
target_id
status
error
imported_at
```

Importers are rerunnable and key on source identity, not fuzzy matching.

### Order

1. Identity, workspaces, memberships, preferences.
2. Companies, contacts, projects, spaces.
3. Tasks, boards/views, events, focus sessions.
4. Artifacts, versions, files, documents, sources, links.
5. Opportunities, roles, applications, materials.
6. Threads, messages, runs, events, questions, memories.
7. External-account references and historical actions.
8. Learning, rewards, and recomputed embeddings.

### Identity mappings

- People: verified email/provider ID first; fuzzy name matches require review.
- Companies: normalized domain first; reviewed name match second.
- NeuralFlow boards become view configuration while tasks migrate independently.
- Notes/documents/outputs become typed artifacts with immutable versions.
- Recompute mixed-model embeddings in Polymath.
- Import action/run history without re-execution.

### Cutover

1. Dry-run into a Neon branch.
2. Validate counts, checksums, samples, invariants, and journeys.
3. Run incremental import.
4. Switch one domain's reads to Neon.
5. Hold donor domain read-only during soak.
6. Reconcile daily.
7. Archive after sign-off.

Rollback restores the prior read path or Neon snapshot. External writes cannot be naively rolled back and require reconciliation.

## Testing

### Unit

State machines, policy, ranking, scheduling, mappings, redaction, and risk classification.

### Integration

Real Postgres transactions for idempotency, conflicts, audit/outbox atomicity, tenancy, vector search, and full-text search.

### Contract

Sanitized Composio/Firecrawl fixtures, companion schemas, and stable API problem responses.

### Workflow

Pause/resume, cancellation, duplicate deliveries, timeout and unknown reconciliation, retry, and spend settlement.

### End-to-end

- Briefing to focus completion.
- Capture to task/note.
- Alfred research to cited artifact.
- Gmail draft to review to confirmed test send.
- Upload to extraction/search.
- Application preparation without submission.

### Migration

Golden donor fixtures, counts, checksums, referential checks, duplicate reports, rerun idempotency, and source/target sampling.

## Observability

- OpenTelemetry-compatible traces across requests, workflows, models, tools, and DB.
- Structured logs with request/workspace/run/proposal/provider IDs.
- No secrets or raw sensitive bodies.
- Metrics for queue age, sync lag, run state, approvals, latency, retry, reconciliation, spend, and search success.
- Health views distinguish configuration, auth expiry, provider outage, rate limit, and product defect.

## Implementation sequence

1. **Standards:** scaffold Next.js 16, strict TS, pnpm, Tailwind/shadcn, Vitest, Playwright, Drizzle, and CI.
2. **Primitives:** Clerk tenancy, Neon, transactions, idempotency, versions, audit, outbox, webhook inbox, shell, design tokens.
3. **Daily loop:** capture, tasks, projects/spaces, boards/views, calendar, focus, Briefing, Inbox, Work.
4. **Alfred:** conversations, runs, events, questions, AI SDK, SSE, spending, Firecrawl, artifacts, Eve adapter if confirmed.
5. **Connected actions:** Composio accounts/triggers, Reviews, Gmail/Calendar first, then Drive/Notion/GitHub/Linear/Vercel.
6. **Knowledge:** Tiptap, documents, extraction, search, graph, learning, reports, rewards.
7. **CRM/opportunities:** contacts, companies, correspondence, roles, applications, companion.
8. **Cutover:** full imports, parity, security/performance review, domain switches, read-only soak, archive.

## Definition of done

A donor domain is consolidated only when:

- Polymath owns canonical schema and mutation behavior.
- Imports are idempotent and reconciled.
- Core journeys meet acceptance criteria.
- Safety and tenancy tests pass.
- Work survives restarts and duplicate delivery.
- Audit, metrics, recovery, loading/error states, and documentation exist.
- The donor domain can become read-only without functional loss.

## Immediate tickets

1. Inventory Alfred/Eve.
2. Decide the durable workflow provider through an ADR.
3. Scaffold app, CI, Clerk, Drizzle, Neon branching, and migration harness.
4. Implement tenancy, request receipts, audit, outbox, webhook inbox, and error contracts.
5. Create canonical enum and identity maps.
6. Build vertical slice: capture → task → briefing → focus → completion → audit.
7. Build agent slice: Alfred → Firecrawl → cited artifact → run timeline.
8. Build action slice: Gmail draft → review → send → reconcile with a test account.
