# engineering.md — How code is written here

**Purpose:** the rules a change must satisfy. Behaviour is owned by
[axiom-nextjs-neon-plan.md](../docs/axiom-nextjs-neon-plan.md); this file owns
how the code is shaped on the way there.

Bias: **DHH's Rails** (fat models, thin controllers, no service layer for its own
sake, deleting code is a feature, the framework does the boring part) plus
**Guillermo Rauch's** Next.js/Vercel posture (server-first, ship small, DX is
product, the platform is the distributed system). Concretely: boring, obvious,
deletable code that a stranger can read at 3am.

## The ladder

Stop at the first rung that holds. Two rungs work — take the earlier one and move on.

1. Does this need to exist? Speculative need = don't build it; say so in one line.
2. Does it already exist in this repo? Reuse the helper, type, or pattern. Re-deriving
   what lives three files over is the most common waste.
3. Does the platform do it? Postgres constraints, `timestamptz`, `input type="date"`,
   CSS, Server Actions, `revalidateTag`, RSC streaming.
4. Does an installed dependency do it? Use it. Adding a package for a few lines is a
   permanent cost paid to avoid a temporary one.
5. Can it be one line?
6. Only now: the minimum code that works.

The ladder shortens the solution, never the reading. Understand the whole flow —
every caller of the function you are about to touch — before choosing a rung.

## Module boundaries

```text
src/app/         routes, layouts, RSC pages, server actions, route handlers
src/components/  presentation; no data access
src/domains/     one folder per domain: schema, commands, queries, policies, events
src/integrations/ composio, firecrawl, object storage, model providers
src/workflows/   durable workflow definitions, steps, signals
src/lib/         auth, errors, idempotency, telemetry, validation
```

- A domain owns its tables. **UI code never queries another domain's tables
  directly** — it calls the domain's query. Cross-domain work goes through a
  command or an event, not a join.
- Flows point one way: `app → domains → integrations → lib`. `lib` imports nothing
  from `domains`. `integrations` never import UI.
- One file per concept, named for what it does. No `utils.ts` catch-alls, no
  `helpers/`, no barrel `index.ts` re-exporting a directory.
- No interface with one implementation, no factory for one product, no config for a
  value that never changes. Type the seam when a second implementation actually
  arrives.

## TypeScript and Next.js

- `strict: true`, no `any`, no non-null `!` on provider data. Parse at the boundary
  with Zod and pass typed values inward; everything from a provider, webhook, model,
  or file is untrusted until parsed.
- **Reads are server components.** Compose the view model server-side, in parallel,
  bounded. Never call this app's own HTTP endpoints from the server.
- **First-party mutations are server actions**, in this order: authenticate →
  resolve `AuthContext` → parse input → idempotency + expected-version checks →
  domain command → audit/outbox in the same transaction → invalidate cache tags.
- **Route handlers** exist for `/api/v1`, webhooks, SSE, signed file URLs, health,
  and workflow kickoff. Nothing else. They return stable problem-detail errors.
- Client components are islands at the leaves, and only when interaction demands it.
  `"use client"` at the top of a page is a smell.
- Long work never lives inside a request. It creates a run/job row and starts a
  durable workflow.
- Default to dynamic for authenticated mutable data. Cache only stable catalogs, with
  tags. Never put secrets or unbounded user data in a shared cache.

## Data

- Every owned table has `workspace_id`. Queries are scoped by `AuthContext`; the
  server resolves the owner, a client never supplies it.
- Common mutable shape: `id uuid pk`, `workspace_id`, `created_by`, `updated_by`,
  `created_at`, `updated_at`, `archived_at`, `version integer default 1`.
- Enforce invariants in the database — `unique`, `check`, `not null`, partial
  indexes — not only in application code. The constraint is the one check that
  survives every future caller.
- Every mutation takes an idempotency UUID (`request_receipts`). Mutable rows carry an
  integer `version`; stale writes are rejected, not silently merged.
- Audit and outbox rows are written **in the same transaction** as the change they
  describe. A change with no audit row did not happen.
- JSONB is for provider payloads and genuinely flexible metadata. Anything queried,
  sorted, or constrained gets a column.
- Migrations are forward-only SQL, reviewed, and never edited after they run. Use
  Neon branches to rehearse destructive ones.
- Never hold a transaction open across a provider call. Reserve, commit, call,
  settle.

## Agents

- All agent execution goes through the `AgentEngine` contract
  (`start` / `signal` / `cancel` / `resume`). Domain code never imports a model SDK,
  Eve, or a workflow platform directly.
- A run captures its policy snapshot at start — profile, model, tools, budget — and
  cannot escape it. Tool availability is bounded by profile, feature, account,
  policy, and run; the full catalog is never handed to a model.
- Runs are durable. Retries create new runs; terminal states are immutable; tool
  results are append-only. Reload reconstructs the timeline from events.
- Persist visible summaries, decisions, evidence, redacted tool arguments, and
  status. Never persist hidden chain-of-thought.
- Spend is reserved before paid work and settled after. No run spends past its
  captured budget.
- External writes become action proposals — preview, risk class, dedupe key, expiry,
  expected effect — never a direct call from a tool.

## Errors

- One error shape (`problem+json`) across the API, with a stable machine code.
  Codes are added, never repurposed.
- No swallowing. Every `catch` either handles the error, adds context, or rethrows.
  A `catch` that logs and continues is a bug report waiting to be filed.
- Boundary behaviour is explicit: backend or provider down → a labelled status card,
  not a crash and not an empty list pretending success.
- Partial failures are visible as partial. Never render an incomplete result as whole.
- Input validation at every trust boundary — HTTP, webhook, provider response, file,
  model output.

## Tests

- Test behaviour through the domain's public interface, not its internals.
- Non-trivial logic leaves **one runnable check**: smallest thing that fails if the
  logic breaks. Logic that branches, loops, parses, or touches money/security is
  non-trivial. One-liners are not.
- Invariant tests (idempotency, version conflicts, audit atomicity, tenancy, vector
  and full-text search) run against **real Postgres**, not a mock. Mocks prove the
  mock works.
- Provider contract tests use sanitized fixtures — never live calls in CI, never real
  contacts, mail, resumes, tokens, or screenshots of private data.
- Playwright covers journeys, not pages: capture → task → briefing → focus →
  completion; note → search → cite; proposal → approve → confirm.
- Don't assert on snapshots of markup. They pass while the UI is broken and fail when
  it is merely changed.
- Every fixed bug gains the one check that would have caught it.

## Performance

Budgets are in the product spec and are treated as tests, not aspirations:
initial route JS under 180 KB gzip, LCP under 2.5 s p75, INP under 200 ms p75,
one composition boundary for Briefing, virtualize above 200 rows, paginate every
server collection.

Query hygiene: no N+1 (select what the view needs in one round trip), index every
column a hot query filters on, keep transactions short, and log an index when you add
a filter.

## Comments and docs

- Comment the **why** and the non-obvious constraint. Never the what — the code says
  what.
- No commented-out code, no `TODO(name)` without an owner, no section banners.
- Mark a deliberate simplification with its ceiling and the upgrade path when the
  ceiling is real (e.g. `// global lock; per-account locks when throughput matters`).
- A change that alters behaviour updates the doc that owns that behaviour:
  `docs/` for product and architecture, `agents/` for stance.

## Anti-patterns

Named so they can be rejected on sight: repository and service layers wrapping plain
ORM calls; DTOs mirroring models; a `useEffect` fetching data the server already had;
`any` in a signature; boolean traps (`doThing(true, false)`); a new abstraction
introduced "for the second caller" that does not exist; renaming for the sake of a
diff; a helper used once, inlined; state that Postgres already holds; validation that
only exists in the client; retry without idempotency; a feature flag with no date to
die.

## Definition of done

Beyond the plan's test gates: `make check` (lint, typecheck, build, tests) passes;
no new dependency without a reason in the commit message; the diff is the smallest
one that is correct; deleted lines are counted as progress; and a reviewer who has
never seen the feature can follow it top to bottom in the files the change touched.
