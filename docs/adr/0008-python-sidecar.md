# ADR 0008: Python sidecar service (FastAPI + SQLAlchemy on Neon/pgvector)

**Status:** PROPOSAL — scaffold merged as evidence; the boundary decisions below
stand unless the owner reverses them.
**Date:** 2026-10-21
**Refs:** ASH-206 (voice/harness), ASH-201 (flagship journey), ASH-180 (release
gates), ADR 0006 (authority lives in Axiom), ADR 0004 (RLS), ASH-178 (local
research stack: docling-serve, SearXNG, Firecrawl).

## Supersedes

The 2026-10-19 owner decision "Next.js + TypeScript + Neon only — no
FastAPI/Python service". On 2026-10-21 the owner explicitly opened the Python
option: a FastAPI + SQLAlchemy service on Neon with pgvector, interoperable with
the Next.js app, with efficiency on any device as the goal. This ADR records
how Python enters the stack without breaking the invariants the TS-only rule
was protecting.

## Problem

Three pressures no longer fit inside Vercel-hosted Next.js alone:

1. **Compute shape.** Document extraction (docling), batch embedding, and
   long agent runs are minute-scale, memory-heavy jobs. Vercel functions are
   request-scoped and time-limited, which is why ADR 0006/ASH-115 forced
   resumable job tables for anything long.
2. **Realtime.** ASH-206 wants a voice-enabled assistant that answers in real
   time. A realtime voice loop needs a long-lived bidirectional connection
   (WebSocket); that is not a Vercel serverless primitive.
3. **Library gravity.** The extraction/ML ecosystem Polymath already leans on
   (Docling, jev-classify-style classifiers, embedding tooling) is
   Python-first. The repo already runs docling-serve as a local Python sidecar
   in `compose.yaml`; this ADR generalizes that pattern into one owned service
   instead of N ad-hoc containers.

## Decision

Add **one Python sidecar service** (`services/sidecar/`, FastAPI + SQLAlchemy
async + asyncpg) that talks to the same Neon database (pgvector) and is called
only by the Next.js server. It is a **capability service, not a second
orchestrator**: Eve remains the single orchestrator for all agentic work
(owner decision, ADR 0006). The sidecar executes bounded units of work Eve or
app routes hand it, and holds no product authority.

### What belongs in the sidecar (as needed, each behind its own PR)

- Heavy document work: docling-based extraction, page/span computation,
  OCR-adjacent processing.
- Batch embeddings and re-embedding on pgvector (backfills, model migrations),
  matching the canonical `vector(1536)` column shape.
- The realtime voice transport for ASH-206 (WebSocket gateway to a realtime
  speech model), which cannot live on Vercel functions.
- Local ML classifiers (e.g. the ASH-202 transaction-classifier lineage) when
  they outgrow a TS implementation.
- Long-running harness workers for ASH-206's supervisor/sub-agent direction —
  as *workers executing Eve-orchestrated jobs*, with run state in canonical
  tables, never a parallel runtime.

### What stays in Next.js/TypeScript (unchanged)

- All UI and product API surfaces. The browser never talks to the sidecar.
- **Authority.** Authentication, workspace resolution, grants, budgets and the
  deny-by-default tool gateway stay in Axiom per ADR 0006. The sidecar does
  not interpret Clerk sessions, grants or policies.
- **Canonical schema and migrations.** Drizzle remains the single migration
  owner (`src/db/migrations`, append-only, guarded by `check:migrations`).
- Proposals, approvals, receipts and idempotency for external effects
  (`withReceipt`, send-executor).

### Interface between Next and the sidecar

- Server-to-server HTTP(JSON) only; the browser never sees the sidecar.
- Caller authenticates with a shared bearer secret (`SIDECAR_TOKEN`), same
  pattern as `CRON_SECRET` on the internal cron route. Fail closed: the
  sidecar refuses to serve `/v1/*` when the token is unset.
- Every call carries an explicit `workspace_id`; the sidecar scopes every
  query by it. A call without a workspace is rejected.
- Job-shaped calls carry an idempotency key; the sidecar enforces
  `(workspace_id, idempotency_key)` uniqueness, mirroring the app's receipt
  discipline.
- Canonical **reads** from Python are allowed with workspace scoping.
  Canonical **writes** go back through the Next app (internal route or the
  outbox) in phase 1, so invariants, RLS plans and audit stay in one codebase.
  Direct canonical writes from Python require a later ADR amendment.

### Schema ownership

- Canonical tables: Drizzle migrations only. Python never alters them.
- Sidecar-owned state (job queue, voice session state, scratch indexes) lives
  in a separate Postgres **schema `sidecar`** on the same Neon database,
  created by SQLAlchemy (`create_all`; Alembic if it grows). Same Neon +
  pgvector stack, one database to operate, no second datastore.
- pgvector is shared: sidecar embedding work targets `vector(1536)`, the
  canonical dimension (`src/integrations/embeddings/provider.ts`).

### Local development

`docker compose up` gains a `sidecar` service (Dockerfile in
`services/sidecar/`) next to db/docling/searxng/firecrawl. For iteration it
also runs bare: `uvicorn app.main:create_app --factory` with `DATABASE_URL`
pointing at the compose Postgres. Tests: `pytest` (unit tests run on SQLite;
pgvector round-trip tests run against real Postgres in CI).

### Hosting options and cost (estimates as of 2026-10-21 — verify before any spend)

| Option | Cost | Fit |
| -- | -- | -- |
| Local (Ashwin's machine, compose) | $0 | Development; matches the "Eve local on your machine" decision. Not an acceptance environment (ASH-180: hosted only). |
| Render free web service | $0 (free instance hours; sleeps when idle — render.com/docs/free) | Fine for on-demand batch work; cold starts disqualify it for realtime voice. |
| Fly.io shared-cpu machine | ~$2–6/mo depending on size (fly.io/pricing, usage-based) | Always-on; the realistic home for the voice gateway. |
| Railway | Free plan has a small monthly credit; Hobby ~$5/mo (docs.railway.com/pricing/plans) | Always-on alternative to Fly. |

Sequencing: local + CI first (this scaffold), Render free for batch-shaped
workloads if hosted is needed, and an always-on VM (~$2–6/mo) only when the
voice loop ships — that spend needs the owner's explicit go-ahead, as does any
realtime speech API usage (billed per minute by the provider).

## Consequences

- One new service to operate; CI gains a `sidecar` job (ruff + pytest against
  real pgvector) so Python code is gated like TS code.
- The "TS-only" simplicity is deliberately traded for compute shape and
  library access. The trade is contained: authority, schema and external
  effects never cross into Python.
- Neon branching stays the isolation mechanism; the `sidecar` schema rides
  along in every branch.
- If the sidecar direction is reversed, deleting `services/sidecar/`, the
  compose service, the CI job and the `sidecar` schema removes it entirely;
  no canonical table changes were made.

## What the scaffold proves (merged with this ADR)

- FastAPI app with fail-closed bearer auth, workspace-scoped job intake with
  idempotent replay, health endpoint.
- SQLAlchemy async models on the `sidecar` schema; pgvector `Vector(1536)`
  table created and round-tripped against real Postgres in CI.
- compose + Dockerfile + CI job, so the service builds and tests like the
  rest of the repo.

## Next steps (each its own PR/ticket)

1. Wire the extraction provider seam (`src/integrations/extraction/`) to offer
   the sidecar's docling endpoint as a hosted-capable adapter.
2. ASH-206: realtime voice gateway design (provider choice, per-minute cost
   estimate for owner approval) on the sidecar's WebSocket surface.
3. Batch re-embedding worker consuming sidecar jobs for the pgvector corpus.
