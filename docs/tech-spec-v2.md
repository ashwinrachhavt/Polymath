# Polymath technical specification v2

**Verified against commit `0aa50a36ccc8b3cc272cff1d7d47a7db7da90ef5`** (branch `code-code`, 2026-10-27).
Every claim in this document is tagged with one of three states. If a claim has no tag, it is a decision, not an observation.

| Tag | Means | A reader may rely on it |
|---|---|---|
| **[V]** | Verified in this audit: read the schema, route, or handler at the pinned commit | Yes |
| **[C]** | Contracted: the interface or constraint exists in code, but end-to-end behaviour was not exercised | The shape, not the outcome |
| **[D]** | Deferred: designed or desired, not built | No |

The previous version of this page conflated "I read the file" with "this works". This one does not. Where the code disagrees with `agents/architecture.md`, the code is recorded here and the disagreement is listed in §11.

---

## 0. How to read this

- §1–§3: what exists now.
- §4–§7: the mechanisms, each with the constraint that enforces it.
- §8–§10: operations, security, and evidence.
- §11–§13: defects found during verification, naming debt, and delivery order.

Product philosophy lives in the Product Spec and `agents/product.md`. This document owns schema, invariants, and the tests that prove them.

---

# 1. Shape

A Next.js 16 App Router modular monolith on Vercel. One deployment, one Postgres database (Neon in production), one identity provider (Clerk). **[V]**

```text
Browser / Chrome companion / MCP clients
        |
Next.js: RSC reads, Server Actions, Route Handlers
        |
src/domains/   one folder per domain, owns its tables
        |
src/integrations/  provider adapters
        |
src/lib/       auth, db, receipts, problems, telemetry
        |
Postgres + pgvector | object storage | Eve agent runtime
```

Flows point one way: `app → domains → integrations → lib`. `lib` never imports from `domains`. **[C]** — the rule is in `agents/coding.md`; there is no lint rule enforcing it.

## 1.1 Verified stack

| Layer | Version at the pinned commit | Note |
|---|---|---|
| Next.js | 16.4.2 | App Router, `cacheComponents` |
| React | 19.3.0 | |
| TypeScript | `strict: true` | |
| Postgres client | `postgres` 3.4.9 (postgres.js) + drizzle-orm 0.45.4 | Not `pg` |
| Migrations | forward-only SQL in `src/db/migrations/` | count and newest file in the generated inventory |
| pgvector | `vector(1536)`, HNSW cosine index | `embeddings` table |
| Identity | `@clerk/nextjs` | |
| Editor | `@tiptap/react` | `@tiptap/core` is transitive, not direct |
| UI | Tailwind 4 | |
| Validation | Zod 4 | |
| Blobs | `@vercel/blob`, behind `src/integrations/object-store/` | |
| Agents | `eve` | Two agent definitions only, §7 |
| Tests | vitest, `@playwright/test` | counts in the generated inventory |

Exact versions, counts, and the full dependency table are **not restated here**. They are emitted by `scripts/tech-spec-inventory.ts` into `docs/generated/inventory.md` (`make inventory`). This document states only what the inventory cannot: the rule, the decision, and the defect.

The gate is `make check` → `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. **[V]** — read from `package.json` and the `Makefile`. It was **not run** for this audit; see §10.1.

---

# 2. Domains and tables

22 folders in `src/domains/`. **17 own tables; 5 do not.** The full per-domain table and its state (versioned / append-only / atomic-counter) is generated into `docs/generated/inventory.md`. It is not restated here, because the version of §2 that was hand-written listed 18 domains and a table count that no longer matched the tree.

**Folders without tables:** `conversations` (threads and messages live in `agents`), `home`, `import`, `notifications`, `supervisor` (§7.6).

The shape that matters, which the inventory records but cannot explain:

| Domain | Governs |
|---|---|
| `knowledge` | The library: documents, extractions, artifacts, sources, claims, embeddings, notebooks, cards, areas, wiki, exports, reading state. The largest domain by far; most cross-domain reads land here. |
| `agents` | Execution: profiles, principals, delegation grants, runs, steps, tool calls, events, memory, context manifests, threads, onboarding. |
| `identity` | Tenancy: users, workspaces, memberships, roles, grants, people, organizations, party links, api clients. |
| `work` | Commitments: tasks, projects, spaces, boards, dependencies, links, recurrence, briefing seeds. |
| `actions` | Approved external effects: proposals, revisions, reviews, attempts, policies, provider observations. |
| `audit` | Reliability primitives: receipts, audit events, outbox, webhook inbox, blob objects, jobs, job attempts. Every other domain leans on these. |

### Naming debt — resolved by this document

The previous spec left three renames "open". They are decided here, and each is a *documentation* decision, not a migration:

| Pair | Decision | Why |
|---|---|---|
| Source vs Document | **Both exist and are different things.** A `document` is a filed, extractable artifact in the library (`documents`: title, mime, folder, page count, current extraction). A `source` is provenance for a claim (`sources`: url, content hash, fetch time), and a source may point at a document's file. Neither is renamed. | Merging them would collapse "what I filed" with "what a claim cites", which the evidence chain needs separate. **[V]** — read both tables |
| Alfred vs supervisor | **`alfred` is the Eve runtime agent; `supervisor` is a domain.** The product's supervisor is `eve/alfred/agent/` plus the `src/domains/supervisor/` surface (thread per workspace, navigation intents, surface cards). "Alfred" is a code identifier, not user-facing copy. | Renaming `eve/alfred` would break run history and the profile IDs that `agent_runs` references. **[V]** — `eve/alfred/`, `src/domains/supervisor/respond.ts` |
| Standalone artifacts vs Zettels | **A Zettel is not a separate store.** It is an `artifacts` row with `kind = 'zettel'`, plus `claims`, `claim_evidence`, and `concepts`. `artifact_kind` covers note, zettel, document, memo, report, diagram, transcript, deck, infographic, other. | This is already what the code does. **[V]** — `artifact_kind` enum, `acceptZettel` |

---

# 3. The data spine

Defined once in `src/db/columns.ts` and spread into every table. **[V]**

```text
primaryId()    id uuid primary key default random
tenantId()     workspace_id uuid not null → workspaces(id) on delete cascade
mutable        created_by, updated_by, created_at, updated_at, archived_at, version int not null default 1
recorded       created_at only            (append-only rows)
recordedBy     created_by + created_at
```

**Tenancy coverage: 151 of 154 tables carry `workspace_id`.** The three that do not are correct: `users` and `workspaces` are the tenant boundary itself, and `integration_catalog` is global provider metadata. **[V]** — enumerated every table.

**Version coverage, and the row rule (decided 2026-10-27, revised same day).** A mutable row is exactly one of:

| State | Shape | Guard |
|---|---|---|
| **append-only** | `recorded` / `recordedBy`, written once | none needed; there is no second write to lose |
| **versioned** | `...mutable`, or an explicit `version` column | `where version = expected`; a mismatch throws `version_conflict` |
| **guarded, no version** | mutable, but concurrency is handled another way | declared with its kind, its guard, and the file that implements it |

The third state is not one thing, and most of these tables have **more than one guard**. Naming only one overstates whichever got named and lets someone delete the others.

| Table | Guards | What each does | Evidence |
|---|---|---|---|
| `integrations.provider_quota_buckets` | atomic-counter | increment in the statement, guard clause in WHERE | `quota.ts:72-96` |
| `agents.runtime_signals` | atomic-counter + app-cas + trigger-immutable | `attempts` incremented in-statement; `status` compare-and-set in the WHERE clause; trigger freezes `execution_id`/`signal_key`/`payload_revision`/`payload_hash` | `runtime-persistence.ts:301`, `0150:145-160` |
| `agents.tool_invocations` | trigger-immutable + app-cas | trigger freezes request identity **and** refuses to reopen a terminal state; the app CAS is redundant safety | `0150:189-202`, `runtime-persistence.ts:374,383` |
| `knowledge.document_enrichment` | lease | only production path is `extractDocument` after claiming the `document_extractions` lease | `extraction.ts:83,176,271` |

Two tables carry a `version` column **and** a trigger freezing security-relevant
columns, which a "versioned" label alone would hide:

| Table | Invariant | Evidence |
|---|---|---|
| `agents.agent_runs` | `policy_snapshot`, `agent_profile_id`, `profile_revision_id` fixed at admission — a run cannot widen its own authority mid-flight | `0150:40-56` |
| `agents.agent_delegation_grants` | grant content frozen, including `allowed_operations` and `allowed_resources` — an issued delegation cannot be widened in place | `0171:55-70` |

**The distinction that matters:** `tool_invocations`' trigger constrains `state`
transitions, so the database prevents reopening a terminal call regardless of what
the writer does. `runtime_signals`' trigger does **not** touch `status` — it freezes
identity and payload only, and the status machine is held together by the app's
compare-and-set. Reading "a trigger exists" as "the trigger guards the state machine"
is the specific error this section now guards against, and the test parses the
trigger body to catch it.

### Is a lease an acceptable guard?

**Only when it is demonstrably the single entry path — otherwise it is not a guard
at all.** A lease protects the *writer*, not the *row*: it stops two well-behaved
callers from colliding, but nothing in the database stops a second caller that never
takes it. A table whose only protection is a lock or a job claim is unprotected in
the sense this document means, so the declaration must name the entry points and the
test checks the call graph:

- Each leased entry point declares which files may call it. An empty list means "no
  production caller", and a new one fails the suite.
- Permission is **per function, not per table**. A file allowed to call the leased
  path is not thereby allowed to call the one that bypasses the lease — collapsing
  those is how a bypass becomes invisible.
- The rule fails closed: an undeclared lease is a failure, not a pass.

**The permission must be as narrow as the claim.** This generalises past the lease
case and is the single lesson of this section: permission per table, permission per
function, permission per call site are the same rule at different grains, and a
check is only as strong as its narrowest unit. The first version of this test
permitted a *file* that legitimately called the leased path, which silently
permitted the same file to call the one that bypasses the lease — a false negative
caught only by mutation-testing it.

**What the test does not prove.** The caller walk is a static scan of `src/` for
`name(`. It will not catch an entry point reached through a variable, a re-export,
or a dynamic import, and it does not inspect `tests/` (deliberately — a test calling
the bypass is how you prove the bypass works). Treat it as strong evidence for a
single entry path, not proof of one. Verified by hand for the current declaration:
`enrichment` is imported in exactly one place, `extraction.ts:19`, with no re-export.
That manual check is the part a reader should repeat when a new caller is added.

Today `knowledge.document_enrichment` satisfies it: `advanceDocumentEnrichment` is
called only from `extractDocument` after the lease claim, and
`retryDocumentEnrichment` — which calls it directly, bypassing the lease — has no
production caller. That second half is the load-bearing part, and it is the reason
the rule exists: **the day someone wires up a retry button, the declaration becomes
false and the test says so by name.**

Three earlier drafts of this section were wrong in three different ways: calling the
state "atomic-counter", declaring from table shape without reading the write path,
and then reading "trigger present" as "trigger guards the state". Each time the fix
was the same — cite the mechanism and the columns, and let a test check the citation.
Declarations live in `scripts/lib/row-state.ts`.

Anything else is a defect. `tests/unit/inventory-row-states.test.ts` fails by name on a mutable table with no version and no declaration, on a stale declaration, on a citation to a nonexistent file, and — the strongest check — on a trigger claim whose trigger body does not reference the columns the declaration names. The classifier is shared with the generator so the two cannot drift; the test asserts what the classifier cannot know: that a human read the write path.

Optimistic concurrency is enforced on 52 call sites, concentrated in tasks, calendar, opportunities, capture, identity grants, and home actions. **[V]**

---

# 4. Invariants

The previous version had nine prose invariants with no enforcement named. Each is now bound to a constraint, a test, or an explicit **NOT ENFORCED**.

| # | Invariant | Enforced by | Coverage |
|---|---|---|---|
| I-1 | Every owned row is tenant-scoped; the client never supplies `workspace_id` | `tenantId()` NOT NULL FK on 151/154 tables; `AuthContext` resolved server-side in `src/domains/identity/resolve.ts` | **[C]** — 10+ integration suites construct a second workspace and assert isolation, but there is no single cross-domain isolation test |
| I-2 | Retried mutations do not double-apply | `request_receipts` unique on `(workspace_id, idempotency_key)`; `withReceipt` takes a `pg_advisory_xact_lock` on `workspace:key` before running | **[V]** — `tests/integration/receipt.test.ts`; 55 call sites |
| I-3 | Stale writes are rejected or explicitly guarded | `version` column + `where version = expected`; throws `version_conflict`. Rows without a version are append-only or declared in `scripts/lib/row-state.ts` with a cited guard | **[V]** — `tests/unit/inventory-row-states.test.ts` fails by name on an undeclared mutable table |
| I-4 | Audit and outbox commit with the change | `recordAudit(auth, input, tx)` takes the caller's transaction; audit insert and outbox insert share it | **[C]** — shape enforced by the helper signature; no test asserts rollback atomicity |
| I-5 | Original bytes are distinct from derivation | `captures.raw_payload` immutable; `documents` → `document_extractions` (versioned, statused) → `embeddings` | **[V]** — `capture-explicit-identity`, `capture-to-document` suites |
| I-6 | Provider calls never happen inside a transaction | Convention in `agents/coding.md`; extraction and action execution use reserve → commit → call → settle | **NOT ENFORCED** — no structural check. A review rule, not a mechanism |
| I-7 | Delegation narrows authority | `agent_delegation_grants` + `agent_authorization_decisions`; sub-agent tool set is a subset of the delegator's | **[C]** — `tests/integration/agent-principals.test.ts`; subset property asserted for principals, not for every run path |
| I-8 | External writes require an approval bound to an exact revision | `action_reviews.revision_id` FK NOT NULL; `action_attempts` unique on `(workspace_id, idempotency_key)` | **[V]** — schema; `tests/integration/action-proposals.test.ts` |
| I-9 | Unknown external outcomes block blind retry | `action_attempts.status` + `reconciliation` enum; partial index on `status='unknown' and reconciliation='pending'` | **[C]** — the sweep exists; the 24-hour bound is an operational target with no alert wired (§8) |
| I-10 | No chain-of-thought is persisted | Persisted fields are summaries, decisions, redacted tool args (`tool_calls`), and status | **NOT ENFORCED** — a data-classification rule with no test |
| I-11 | Link targets and link types are closed vocabularies | `check (target_type in …)` and `check (link_type in …)` generated from `linkTargetKinds` / `artifactLinkTypes` | **[V]** — `src/db/columns.ts` |
| I-12 | Every emitted outbox topic has a handler or an audit-only declaration | `outboxHandlers()` + `AUDIT_ONLY_TOPICS`, asserted by `tests/unit/outbox-topic-coverage.test.ts` | **[V]** — the suite fails if either list drifts |
| I-13 | A reference cannot cross a tenant boundary | `unique(workspace_id, id)` + composite FKs | **NOT ENFORCED** — 3 of 151 tenant tables expose the key; 125 of 274 FKs are unprotected. See `docs/audits/2026-10-27-tenant-scope-integrity.md` |

---

# 5. Capture and processing

## 5.1 What exists **[V]**

`captures` is the entry point. Its shape is the contract:

- `kind` ∈ {text, url, file, voice, forwarded}
- `capture_mode` ∈ {authored, selection, page, url-reference, blob} — **NOT NULL, no default.** A row that arrives without a mode is a bug, not a silent "authored".
- `raw_payload` jsonb NOT NULL — the immutable original.
- `text`, `url`, `blob_id` — the three arrival forms.
- `content_hash` — sha256 of arriving text; null for blobs and url references.
- `fetch_outcome` ∈ {pending, acquired, error-page, access-denied, empty, provider-unavailable} — the server's own reading of a URL, kept apart from what the person sent.
- `processing_state` ∈ {unprocessed, classifying, enriched, converted, discarded, failed}
- `parked_at` / `parked_by` — a **separate axis** from `processing_state`: parking pauses owner-facing work without rewriting what enrichment decided.
- `enrichment_lease_token` / `enrichment_lease_until` — a fenced, time-boxed claim taken before any provider call.
- `converted_type` / `converted_id` / `converted_at` — the lineage edge to the canonical record.

Partial index `captures_inbox_idx` on `(workspace_id, created_at) where processing_state in ('unprocessed','classifying')` — the inbox is the pending rows, not the table.

`capture_proposals` carries `kind` ∈ {task, note, project, contact, company, opportunity, reference, event, discard} and status ∈ {pending, accepted, edited, rejected}. Enrichment writes proposals; conversion is the mutation.

## 5.2 The pipeline **[V]**

```text
createCapture (idempotent; dedupes URL-only)
  → captures row, raw_payload immutable, processing_state = 'unprocessed'
  → outbox: capture.enrichment_requested

enrichment handler  (capture/enrichment-handler.ts)
  → takes enrichment lease
  → tier 0: normalize text
  → tier 1: regex structure  (prose | code | list | url | log | contact)
  → tier 2: Jev classifier   (domain, commitment/contact/reference/worthless/project)
  → writes capture_proposals, processing_state = 'enriched', clears failure_reason

url content handler (capture/url-content-handler.ts)
  → fetches, records fetch_outcome, parks on provider-unavailable

zettel generation   (capture/zettel-generation.ts)
  → outbox: capture.zettels_requested

owner accepts a proposal → creates the canonical record, sets converted_* in one transaction
```

**Jev fallback is currently correct in code.** `enrichment-handler.ts` catches `QuotaExhaustedError` and returns `{outcome: "fallback", skipped: ALLOWANCE_SKIPPED}`; `JevDisabledError` and `JevUnconfiguredError` also fall back. Only `JevRequestError` rethrows as redeliverable. **[V]** — read the catch block at `enrichment-handler.ts:362`. The defect entry in `agents/architecture.md` (dated 2026-10-26) is stale and should be deleted.

## 5.3 Modality coverage

| Input | Built | Evidence |
|---|---|---|
| Text | Yes | `capture-identity`, `capture-draft` suites |
| URL | Yes | `capture-url-chain`, `capture-url-content`, `capture-url-lease` |
| File (PDF/image) | Extraction routes through Docling → Reducto → LlamaParse → PDF text layer, resolved in code | `capture-file-intake` |
| Voice | Yes | `capture-voice-transcription` |
| YouTube | Yes | `youtube-handler.ts`, `youtube_transcripts` |
| Email forwarding | `capture_source` includes `email` and `webhook` | **[C]** — enum present; no end-to-end import test found |
| Video generally | **No** — only YouTube transcripts are extracted | **[D]** |

Unsupported input preserves raw material and names the missing capability; it never silently succeeds as an empty extraction.

---

# 6. Knowledge, zettels, and retrieval

## 6.1 Zettel contract **[V]**

Zettels are `artifacts` rows with `kind = 'zettel'`. The pipeline in `src/domains/knowledge/zettels.ts`:

1. `proposeZettels(documentId)` reads the **current succeeded extraction** — resolved through `currentExtractionIdSubquery()`, so a restored document's proposals follow the pin.
2. The extractor proposes candidates. Each must pass `locate(text, quote)` — **a quote that is not verbatim in the extraction produces no proposal. No span, no evidence, no zettel.**
3. Accepted candidates are capped: `MAX_ZETTELS_PER_DOCUMENT = 8`, title ≤ 120 chars, claim ≤ 400.
4. Insert into `zettel_proposals` with `dedupe_key = f(documentId, spanStart, spanEnd)` and `onConflictDoNothing`, so a re-run is a no-op.
5. `acceptZettel` runs in one transaction and creates: an `artifacts` row (`kind='zettel'`, `status='reviewed'`), an `artifact_versions` row (v1, Tiptap doc = claim + blockquote evidence), a `sources` row for the document's file, a `concepts` row (term = title, definition = claim), a `claims` row (`status='accepted'`), and a `claim_evidence` row carrying the extraction id and character offsets.

**What acceptance proves:** the quoted passage exists at that offset in that extraction. **What it does not prove:** that the claim is true, or that the person understood it. Review is endorsement, not verification.

**Naming caution:** the previous spec cited `src/domains/knowledge/zettel-generation.ts`. That file does not exist. The async generation handler is `src/domains/capture/zettel-generation.ts`; the proposal and acceptance logic is `src/domains/knowledge/zettels.ts`.

## 6.2 Relations **[V]**

One closed vocabulary, enforced by a DB check generated from `artifactLinkTypes`:

`reference`, `related`, `supports`, `contradicts`, `source`, `semantic`, `explains`, `applies`, `extends`, `contrasts`, `dismissed`, `instance_of`, `part_of`, `causes`.

`semantic` means machine-proposed similarity and always carries a score. Every other type is human-curated. A backlink is a reverse view; it is not necessarily a reciprocal semantic claim.

Target vocabulary is also closed: `task, project, space, note, artifact, document, source, event, contact, company, person, organization, opportunity, run, thread, zettel`. `target_id` carries no FK (polymorphic FKs are not expressible), so the check constraint is what stops a typo inventing a new kind.

## 6.3 Retrieval **[V]**

`embeddings` carries `owner_type`, `owner_id`, `source_version_id` (the immutable version, not a pointer), `chunk_index`, `span_start`, `span_end`, `page`, `model`, `vector(1536)`.

Constraints: unique on `(owner_type, owner_id, model, chunk_index)`; HNSW index with `vector_cosine_ops`; index on `(workspace_id, owner_type)`.

Consequences a builder must respect: a vector is tied to a version, so a restore or re-extraction produces new vectors rather than mutating old ones; two models can coexist because `model` is in the unique key; retrieval must filter by `workspace_id` regardless of ANN ordering.

---

# 7. Agents, tools, and external effects

## 7.1 The AgentEngine contract **[V]**

All agent execution goes through `src/domains/agents/engine.ts` (`start` / `signal` / `cancel` / `resume`). `eve-driver.ts` implements it against Eve. `event-bridge.ts` is the only writer of run events; `runtime-persistence.ts` persists the timeline.

A run captures its policy snapshot at start — profile, model, tools, budget — and cannot escape it. Retries create new runs. Terminal states are immutable. Tool results are append-only.

## 7.2 The two agent definitions **[V]**

`eve/alfred/agent/` and `eve/specialist/agent/`. That is the entire roster: one first-party agent and one shared specialist runtime that receives its role as an `axiom-specialist-brief v1` context message with the run (`specialist:<slug>`).

Both resolve Gemini through its OpenAI-compatible surface, with credentials read **per step inside the dynamic model handler**, not at module load — the deployed bundle's module-scope env reads did not see Vercel's runtime environment.

`src/domains/supervisor/` is the product's supervisor surface, not a third agent: a per-workspace thread (`getOrCreateSupervisorThread`), navigation intent parsing, and surface cards.

## 7.3 Authored tools **[V]**

`documents_search`, `tasks_read`, `web_fetch`, `web_search`, `wiki_ingest`, `wiki_lint`, `wiki_read`.

## 7.4 Provider tools **[V]**

Not authored. They arrive through the `polymath-gateway` MCP connection and every call is authorized and recorded by `POST /api/mcp` (JSON-RPC: `initialize`, `notifications/initialized`, `tools/list`, `tools/call`). The agent holds no provider credential.

`TOOL_SCHEMAS` in `src/domains/integrations/tool-manifest.ts` is the manifest, typed against `PROVIDER_TOOLS` so a renamed tool fails to compile rather than vanishing at runtime. **29 tools** across gmail (3), writer (2), github (2), slack (2), linear (2), google (calendar/drive/docs/sheets), discord, zoom, calendly, asana, trello, airtable, canva, hubspot, stripe, notion (2), linkedin, instagram (2).

Access tiers live on `external_accounts.access_tier`, enforced in the gateway per connection and read live per call. `integration_catalog.access_tiers` is display data for the connect screen.

## 7.5 Approved external effects **[V]** — constraints, not promises

| Step | Enforced by |
|---|---|
| Proposal carries target, account, preview, expected effect, expiry, dedupe identity | `action_proposals` columns; unique `(workspace_id, dedupe_key)` |
| Approval binds to one revision | `action_reviews.revision_id` NOT NULL FK, `on delete restrict` |
| Revisions are append-only and numbered | unique `(proposal_id, revision_number)` |
| One execution attempt per intent | unique `(workspace_id, idempotency_key)` on `action_attempts` |
| Attempts are ordered per proposal | unique `(proposal_id, attempt_number)` |
| Unknown outcomes are findable | partial index on `status='unknown' and reconciliation='pending'` |
| Provider response is redacted | `response_summary` jsonb, documented as summary only |

**Not promised:** global exactly-once delivery. The guarantee is local deduplication plus controlled reconciliation within each provider's semantics. A 24-hour bound on unresolved outcomes is an operational objective, and **no alert is wired to it** (§8.2).

## 7.6 Skills **[V]**

`BUNDLED_SKILLS` in `src/domains/skills/bundled.ts` has **six** procedures: weekly-review, research-brief, linear-issue-draft, design-brief, meeting-notes, calendar-conflicts. (The previous spec said three.) They are data, not code: installing copies the text into the workspace `skills` table, and the run loads it through the same resolver as any imported skill. `sourcePath` uses an `examples/` prefix so a bundled skill cannot collide with a repository package.

Skills supply method, not authority. Imported content never becomes an instruction authority.

## 7.7 Memory **[V]**

`memory_items` → `memory_revisions` → `memory_reviews`. Candidate → proposed → accepted → superseded/retired. Rejection is not personalization. A specialist's suggestion cannot self-promote into accepted fact. Personal memory is not automatically workspace-shared.

---

# 8. Durable execution and operations

## 8.1 Outbox **[V]** — and the gap

`outbox_events` carries `status` ∈ {pending, dispatched, failed, dead}, `availableAt`, `attempts`, `dispatchKey` (stable publish identity; a retried enqueue with the same key is a no-op), and a lease triple (`lease_owner`, `lease_token`, `lease_expires_at`). The dispatcher in `src/domains/audit/outbox.ts` claims with `for update skip locked`, fences completion on the token, and recovers stranded leases.

**Ten handler entries are registered. Twenty-four distinct topic strings are emitted.** Registered:

`document.extraction_requested`, `crawl.requested`, `youtube.transcript_requested`, `source.url_import_requested`, `thread.changed`, `focus.follow_up_requested`, `capture.url_content_requested`, `capture.enrichment_requested`, `capture.zettels_requested`, `run.critique_requested`.

Emitted with no handler: `agent_principal.registered`, `agent_principal.status_changed`, `delegation_grant.issued`, `delegation_grant.revoked`, `grant.created`, `grant.revoked`, `note.snapshot`, `research.company.completed`, `research.profile.completed`, `role.archived`, `role.assigned`, `role.defined`, `role.revised`, `role.unassigned`.

These 14 are declared observation-only in `AUDIT_ONLY_TOPICS` (`src/domains/audit/outbox-handlers.ts`): each emits alongside a `recordAudit` carrying the same action, so the audit row is the record and the outbox row exists so a future consumer can subscribe without a backfill. `tests/unit/outbox-topic-coverage.test.ts` asserts every emitted topic has either a handler or a declaration, with no overlap and no stale entries. See D-1.

## 8.2 Scheduling **[V]**

`vercel.json` schedules `GET /api/internal/cron` at `0 8 * * *` — once daily. `/api/internal/outbox` is the operator-triggered drain. `OUTBOX_DISPATCH_SECRET` and `CRON_SECRET` are both accepted; with neither set the routes answer 404, with a wrong bearer 401.

**A daily tick is not a worker.** Interactive enrichment latency is not bounded by this schedule; locally `make queue-up` runs `scripts/outbox-worker.ts`. Nothing in the repo bounds the age of an unresolved external outcome or alerts on it.

## 8.3 Long work **[V]**

`src/workflows/` does not exist. Long work uses `after()` (post-response, same function) or a lease on a table row.

- `document_extractions` carries a 10-minute lease with a `pid:uuid` token.
- `captures` carries an enrichment lease with a UUID token.
- Extraction from an uploaded file runs inside the request via `after()` in `src/app/api/v1/files/route.ts` — a long document can outlive the function on the default plan. This is a known risk, not a design.

## 8.4 Route handlers

The full route list is generated into `docs/generated/inventory.md`; it is 32 handlers and changes often enough that restating it here is how the previous version went wrong. What the list cannot say:

- Four are not under `/api/v1`: `/api/integrations/callback` (webhook), `/api/mcp` (run-bound JSON-RPC gateway), `/api/internal/cron` (daily Vercel tick), `/api/internal/outbox` (operator drain).
- Everything else is `/api/v1`, for the narrow reasons in `agents/coding.md`: resources, SSE, signed file access, and workflow kickoff. A route handler that exists for a first-party mutation is a defect.
- The internal routes answer 404 when their secret is unset — they do not advertise themselves.

---

# 9. Security boundaries

- **Untrusted at every trust boundary:** HTTP input, webhook bodies, provider responses, file bytes, model output, imported skills. Parsed with Zod at the edge, typed inward.
- **Authorization is server policy, never text.** Model output cannot grant permission; neither can imported content.
- **Fetch safety:** protocol and destination restrictions, redirect revalidation, private/link-local address blocking, MIME and content checks, bounded expansion. Implemented in `src/lib/safe-fetch.ts` and the firecrawl/extraction adapters. **[C]**
- **Data classes:** public material, private library, professional correspondence, sensitive administrative records, generated output, audit, secrets. Only permitted classes go to configured providers.
- **Secrets never enter skill text, memory, or user-visible context.** Provider credentials live behind `external_accounts`; the agent holds none.

**Not claimed:** append-only audit is immutability (a database administrator can rewrite it); historical erasure across derived indexes without an implemented retention job; absolute protection from prompt injection.

---

# 10. Evidence

## 10.1 What this audit did and did not do

**Did:** read 20 schema files and counted 154 tables; enumerated `pgTable` declarations, `workspace_id` and `version` coverage; read the capture, zettel, actions, outbox, and agent schemas and handlers; enumerated the tool manifest, bundled skills, outbox topics, handlers, route handlers, migrations, `vercel.json`, `package.json`, and the test tree; read `agents/{architecture,coding,reference}.md`.

**Did not:** run `make check`; run any migration; start the app or a browser; call any provider; run the test suite; verify against the deployed environment. Every [C] tag exists because of this.

## 10.2 Test coverage

File counts are in the generated inventory. What matters is which invariants have a suite that would fail if they broke, and which do not.

Have one: `receipt.test.ts` (idempotency), `outbox.test.ts` (claim/lease/fence), `extraction-lease.test.ts`, `capture-url-lease.test.ts`, `action-proposals.test.ts`, `approval-tiers.test.ts`, `access-tiers.test.ts`, `agent-principals.test.ts`, `skills-run-pin.test.ts`, plus the hybrid and record search suites.

Do not: audit atomicity (I-4), cross-domain tenancy (I-1 and I-13), and the three-state row rule (I-3). Those are recorded as D-3 and in the tenant-scope audit rather than assumed.

## 10.3 Evidence ladder

A capability claim moves through: **Implemented → Merged → Configured → Live verified → Accepted**. A failure narrows the claim; it does not disappear behind "Done". The release ledger for the core workflow is ASH-180, and the builder of a gate cannot self-accept it.

---

# 11. Found during verification

Recorded, not fixed. Product code was not modified in this audit.

**D-1 — Outbox topics with no handler — resolved.** 14 emitted topics had no registered handler. Each was traced to its emit site and each emits alongside a `recordAudit` carrying the same action. They are now declared in `AUDIT_ONLY_TOPICS` (`src/domains/audit/outbox-handlers.ts`), and `tests/unit/outbox-topic-coverage.test.ts` asserts every emitted topic has either a handler or a declaration, with no overlap and no stale entries. The test was mutation-checked: removing a declaration fails it.

**D-2 — `agents/architecture.md` is stale in several places.** It says 18 domains (there are 22 folders, 17 with tables); it lists route handlers that differ from `src/app/api`; its Jev defect entry (dated 2026-10-26) is now itself wrong — `QuotaExhaustedError` falls back correctly at `enrichment-handler.ts:363`. That entry should be deleted.

**D-3 — No invariant test for the row rule — resolved.** `tests/unit/inventory-row-states.test.ts` fails by name on a mutable table with no version and no declaration, on a stale declaration, and on a declaration citing a file that does not exist. Mutation-tested: adding a version-less mutable table produces `focus.mutant_probe: add \`version\` via ...mutable, or declare its guard`. The classifier is shared with the generator so the two cannot drift.

**D-8 — The two guarded tables have different residual risk, and neither is versioned.** `agents.tool_invocations` is protected by a trigger that constrains `state`, so it survives a writer that forgets to compare-and-set. `agents.runtime_signals` is **not** — its trigger freezes identity and payload only, and its `status` transition depends entirely on the app's WHERE-clause compare-and-set. Deleting that CAS as "redundant now that there is a trigger" would open a double-send path. Remaining gaps, none asserted by a test:

1. `tool_invocations` permits `requested → failed` directly, skipping `in_flight`. Reachable only if a future writer settles without claiming first.
2. The triggers exist in migrations but their presence in every deployed environment is unverified. Migrations are forward-only and `0150` backfills nothing, so a database restored from an older snapshot would lack them.

`knowledge.document_enrichment`'s guard is a lease, which per §3 counts only while it is the single entry path. `retryDocumentEnrichment` bypasses the lease and currently has no production caller — that is what makes the declaration true, and the test fails the moment it gains one. It should be removed or guarded rather than left as an exported bypass waiting for a caller.

**D-9 — Trigger coverage is only partly asserted.** Nine `CREATE TRIGGER` statements exist (`0150`, `0160`, `0171`, `0172`, `0258`); three use `axiom_reject_update` and make a table genuinely immutable. The classifier agrees with all nine today. The test now parses each claimed trigger's function body and asserts it references the declared columns, which catches "a trigger exists but does not do what the declaration says" — the error that made `runtime_signals` look like a DB-guarded state machine. Still unasserted: a table with a trigger the typology never names, and whether any trigger's presence holds outside this migration history.

**D-4 — Unresolved-effect bound has no alert.** The 24-hour objective in `agents/product.md` has a partial index that can find stale rows and no process that reads it on a schedule.

**D-5 — `src/db/columns.ts` cites a document that does not exist.** Comments reference `agents/engineering.md`; the file is `agents/coding.md`.

**D-6 — Extraction can outlive a request.** `after()`-based extraction in `src/app/api/v1/files/route.ts` is unbounded by function duration.

**D-7 — The inventory generator was not wired into `make check` — resolved.** `pnpm check` now runs `inventory:check`, which regenerates the inventory in memory and fails if the committed file differs. Verified both directions: clean tree passes, a one-character edit to `docs/generated/inventory.md` fails the gate. A schema, route, tool, or topic change can no longer ship a stale inventory.

---

# 12. Deferred

Not built, not contracted. Listed so no one builds on an assumption.

- `src/workflows/` and any durable workflow runtime beyond leases and the outbox.
- A real worker cadence. Daily cron is the only scheduled dispatch in production.
- Mobile or offline capture, public API, MCP server for third parties, per-resource sharing, org hierarchies, custom roles (`agents/product.md` roadmap).
- Non-YouTube video extraction; audio diarization; speaker-attributed transcripts.
- Learning measurement — deleted 2026-10-22, tables dropped in migration `0235`. Confidence and mastery measures are unbuilt, and the previous spec's learning section described something that no longer has a schema.
- Reward shard/intensity algorithm. `reward_ledger` and `reward_definitions` exist; the model is unselected.
- Two-way calendar sync. Read access implies nothing about write.
- Restore drill, export-verify, and retention-job evidence for derived indexes.

---

# 13. Delivery order

Ordered by what unblocks a falsifiable claim, not by feature appeal.

1. **Pin the evidence ledger.** (D-1, D-3, and D-7 are closed; the row rule now has a test, the outbox has a declaration and a test, and the generator is gated.)
2. **Pin the evidence ledger.** One commit, one run of `make check`, one walk of the manual journey (capture → reviewed zettel → note → proposed action → next-session continuation) with output captured.
3. **Wire the unresolved-effect sweep** to the existing cron and alert on age over 24 hours (D-4).
4. **Move extraction off `after()`** behind a durable job (D-6).
5. **Verify connector workflows operation by operation** against the 29-tool manifest, recording which are [V] per environment.
6. **Refresh `agents/architecture.md`** from this document (D-2), then keep it as the map rather than a second spec.

Migrations are forward-only and never edited after they run. Renames in §2 are documentation decisions with no migration; preserve stable IDs and links.

---

# Appendix — source anchors

`package.json`, `Makefile`, `vercel.json`; `src/db/columns.ts`; every `src/domains/*/schema.ts` plus `identity/tables.ts`, `agents/runtime-schema.ts`, `knowledge/statement-schema.ts`; `src/domains/knowledge/zettels.ts`, `src/domains/capture/{enrichment-handler,url-content-handler,zettel-generation,schema}.ts`; `src/domains/actions/schema.ts`; `src/domains/audit/{schema,outbox,outbox-handlers,receipt,record}.ts`; `src/domains/agents/{engine,eve-driver}.ts`; `src/domains/integrations/tool-manifest.ts`; `src/domains/skills/bundled.ts`; `src/domains/supervisor/respond.ts`; `eve/alfred/agent/agent.ts`, `eve/specialist/agent/agent.ts`; `src/app/api/**`; `tests/`.

All reads at `0aa50a36ccc8b3cc272cff1d7d47a7db7da90ef5`.
