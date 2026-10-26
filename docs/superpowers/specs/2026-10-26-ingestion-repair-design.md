# Ingestion Repair — Capture to Library

**Status:** design, awaiting approval
**Branch:** `feat/ingestion-repair` (off `origin/main` @ `5e4d312`)
**Date:** 2026-10-26

## 1. The problem

Polymath has two ingestion pipelines and only one of them is trustworthy.

```text
Pipeline A — inbox capture
  quick capture / inbox / Chrome extension
    → createCapture() or createFileCapture()
    → captures + immutable raw_payload
    → outbox: url content fetch, enrichment
    → human conversion, or "Generate zettels"

Pipeline B — library document ingestion
  upload / URL intake / capture-to-document
    → intakeFile()
    → blob_objects + files + documents
    → outbox: document.extraction_requested
    → extractDocument: text, evidence spans, proposals, embeddings
```

The failure is in the handoff. A capture can be safely stored while its
contents never become a searchable document or an evidence-backed claim, and the
interface still reads as though the system took care of it. Three concrete
instances, all confirmed in code:

1. A PDF dropped into global capture is a dead file record. `createFileCapture`
   emits only `capture.enrichment_requested`, and only when the mime type is
   audio. The inbox tells the person so in as many words:
   "The file's contents aren't searchable; the filename is the label."
   (`src/domains/capture/commands.ts:264-270`,
   `src/app/(workspace)/command-center/inbox/inbox-detail.tsx:456`)
2. A browser selection can silently become a whole-page capture. The extension
   sends `{text, url, title}` for both `capturePage` and `captureSelection`;
   `createCapture` queues a URL fetch for any non-null `url`, and
   `url-content-handler` overwrites the working `text` with the fetched page.
   (`extensions/chrome/api.js:177-196`, `commands.ts:119-125`,
   `url-content-handler.ts:74-80`)
3. A second selection from the same article is rejected as a duplicate. The
   unique index is `(workspace_id, source, url) where url is not null`, so it
   covers every url-bearing capture — while `commands.ts:75-77` claims
   "Only url-only captures dedupe on URL."

None of this is a missing feature. The product spec already requires the
behaviour this branch restores:

- §6.1 "Duplicate detection on origin identity and URL. Re-capturing something
  already present surfaces the existing item."
- §8.1 "The original payload is never mutated. Re-fetching identical content
  records a new observation without duplicating the source." States include
  `extraction-failed (retryable)` and `partially-extracted (visibly partial)`.

## 2. What this branch is not

Not a rewrite. Not a new subsystem. `capture` keeps owning its tables and
`knowledge` keeps owning documents; the work is making their contracts agree and
closing the four gaps where a saved thing stops halfway.

Explicitly out of scope for the whole branch: a new workflow engine, per-resource
sharing, mobile, the MCP server, and any change to `src/domains/work/**` or
`src/lib/navigation.ts` (owned by parallel sessions this branch must not collide
with — see §9).

## 3. Scope decisions taken

| Question | Decision |
|---|---|
| How much in this branch | Phase 1 first as its own PR; Phases 2–4 follow as separate PRs on the same branch |
| Capture identity | Selections repeatable (content-hash scoped); page captures refresh as a new observation |
| File capture | Auto-link to a document on capture using the existing blob; no re-upload |
| Zettel coverage | Ship an honest `partially-extracted` label now; section-aware extraction is its own PR |

## 4. Phase 1 — Make capture trustworthy

Ship as PR #1. Five items, all in `src/domains/capture/**`,
`src/app/api/v1/captures/**`, `extensions/chrome/**`, and one inbox component.

### 4.1 `capture_mode`: the discriminator that is missing

The single new fact the system cannot currently represent is **what kind of thing
arrived**, and therefore what processing is legal for it.

New enum and column on `captures`:

```text
capture_mode := authored | selection | page | url-reference | blob
```

| Mode | Arrives as | Immutable | May a server fetch replace `text`? |
|---|---|---|---|
| `authored` | text the person typed | yes | no |
| `selection` | a highlighted fragment plus its page URL | yes | **no** — the fragment is the point |
| `page` | a whole-page grab plus its URL | yes | yes, into `fetched_text`, never over `text` |
| `url-reference` | a bare address, no text | yes | yes — the fetch *is* the content |
| `blob` | a file or audio recording | yes | n/a — there is no text until transcription |

`blob` exists so the column can be `not null` honestly: for `kind in
('file','voice')` the bytes are the capture and `kind` already says which
modality they are. It is not `authored` — nobody authored those bytes, and saying
so would let a search surface imply the file's contents were read.

`capture_mode` is immutable after insert: it describes arrival, not state. It is a
separate axis from `kind` (`text|url|file|voice|forwarded`), which describes
storage shape. They are not synonyms — `kind` says where the bytes live, `mode`
says what the bytes mean.

### 4.2 Stop the overwrite; keep all four texts

Audit §4 requires four distinct texts to survive. Today two are lost.

```text
captures.raw_payload   already exists  the immutable original
captures.text          already exists  the working text (search, enrichment)
captures.fetched_text  NEW              what the server fetch produced
```

`url-content-handler` writes `fetched_text` instead of `text`. Which text the
working column holds is governed by mode:

- `selection` → `text` keeps the fragment, permanently. A fetch may add
  `fetched_text` for context but never replaces the fragment.
- `page` → `text` keeps the browser grab; `fetched_text` is the structured
  reading and becomes the enrichment input.
- `url-reference` → `text` starts null and is filled from `fetched_text` once.

Enrichment reads per mode rather than assuming `text` is final.

### 4.3 Mode-aware duplicate identity

Replace the single unique index with two partial indexes over a new
`captures.content_hash` (`sha256` of the arriving text, null for blob captures):

```text
-- identical re-capture of the same thing dedupes
unique (workspace_id, source, url, capture_mode, content_hash)
  where url is not null and capture_mode <> 'url-reference'

-- a bare address is unique per source
unique (workspace_id, source, url)
  where url is not null and capture_mode = 'url-reference'
```

Consequences, each a deliberate test case:

- Two *different* selections from one article → both kept.
- The *identical* selection captured twice → deduped to the first.
- A page captured again after the article changed → new observation, both kept.
- The same bare URL from a different `source` → separate capture (unchanged).

The misleading comments at `commands.ts:75-77`, `capture/queries.ts:19`,
`extensions/chrome/api.js:160`, and `README.md:82` are corrected in the same
change; the index predicate, not the comment, is now the truth.

### 4.4 Carry URL provenance into the document

`convertCaptureToDocument` passes `sourceUrl: capture.url` to `intakeFile`,
which already accepts it (`src/domains/knowledge/intake.ts:28`) and writes it to
`documents.source_url`. Today the parameter exists and is never supplied from the
capture path (`commands.ts:451-461`).

One wire, no new table. `documents_workspace_source_url_key` already dedupes by
URL, so converting two captures of the same article lands on one document rather
than two.

### 4.5 Retry a failed fetch without inventing a second capture

Today a failed URL fetch records `failure_reason`, completes the event, and the
only way back is a park/unpark detour that happens to re-enqueue the fetch
(`src/domains/capture/parking.ts:118-123`). Re-pasting the same URL is a `409`.
Spec §8.1 requires `extraction-failed (retryable)`.

- New command `retryCaptureUrl(auth, {captureId})`: clears `failure_reason`,
  re-enqueues `capture.url_content_requested` under a fresh dispatch key, and
  audits `capture.url_retry_requested`. It is the explicit form of the detour
  that exists today, not a new capability.
- Re-pasting a `url-reference` whose capture has `failure_reason` set re-enqueues
  the fetch and returns the existing capture instead of a bare `409`.
- Fetch outcomes become distinct instead of one success flag:
  `acquired | error-page | access-denied | empty | provider-unavailable`.
  Today the scraper accepts any non-empty markdown and ignores
  `page.error`/`page.statusCode` (`url-content-handler.ts:99-106`), so a readable
  404 is recorded as acquired content. A 404 becomes `error-page`, and only
  `acquired` fills `fetched_text`.

### 4.6 Enrichment must degrade, not fail

A defect the audit could not see because it read a stale comment: the registry
entry for Jev is `enabled: true` ("Enabled 2026-10-25",
`src/integrations/providers/registry.ts:312`), while two comments in
`enrichment-handler.ts` still claim it "ships disabled". `jevClassifier` throws
`QuotaExhaustedError` when `JEV_MONTHLY_INPUT_TOKENS` is unset or zero, and
`tryJevTriage` converts only `JevDisabledError` and `JevUnconfiguredError` to the
fallback — everything else is rethrown
(`enrichment-handler.ts:334-338`, `src/integrations/jev/provider.ts:78-85`).

So on any deployment where Jev is enabled but unfunded, capture enrichment fails
and redelivers instead of labelling the capture deterministically. Tier 0–2 work
is thrown away because a paid optional tier had no allowance.

Fix: treat `QuotaExhaustedError` as a fallback trigger under the same rule as the
other two, record that the paid tier was skipped and why, and correct the stale
comments. A capture that got the deterministic ladder is `enriched`; a capture
whose optional tier was skipped says so.

### 4.7 The extension reports what it knows

An unanswered enqueue is not proof of a save.

- `queueCapture()` currently returns `{ok: true, delivered: false}` on timeout.
  It returns an explicit `unconfirmed` state instead, reconciled against the
  known local entry id on next contact. The UI says "saved on this device, not yet
  confirmed by the server" and offers retry.
- `base()` probes the configured server and silently falls back to
  `http://localhost:3000`. The fallback is removed: an unreachable configured
  server reports unreachable. Destination binding already prevents misdelivery;
  endpoint selection must stay stable until the person changes it.
- `capturePage` and `captureSelection` send an explicit `mode`, which the route
  accepts as an optional field (defaulting by inference, so older extension
  builds keep working).

### 4.8 Phase 1 schema, states, and acceptance

**Migration** `0257_capture_mode_and_identity.sql`, forward-only:

```text
create type capture_mode as enum
  ('authored','selection','page','url-reference','blob');
alter table captures add column capture_mode capture_mode;      -- backfilled below
alter table captures add column fetched_text text;
alter table captures add column content_hash text;
-- backfill existing rows from kind, then enforce
alter table captures alter column capture_mode set not null;
drop index captures_workspace_source_url_key;
create unique index ... (the two partial indexes above);
```

Backfill: `kind='url' → url-reference`; `kind='text' and url is not null → page`;
`kind='text' and url is null → authored`; `kind in ('file','voice','forwarded')`
→ `blob`.

`content_hash` is computed for rows that carry text at backfill time, so a
re-capture of an already-present selection dedupes against history rather than
only against captures created after the deploy.

**States.** A capture's URL fetch outcome is
`pending → acquired | error-page | access-denied | empty | provider-unavailable`,
with `acquired|error-page|empty` retryable via `retryCaptureUrl`. Re-enqueueing
never rewrites `raw_payload` and never changes `capture_mode`.

**Failure behaviour.** Provider down → `provider-unavailable`, requeued with
backoff, capture stays in the inbox with a visible reason. Duplicate → returns the
existing capture id (unchanged additive 409 member). Quarantined file → no
extraction, no search text, no preview.

**Permissions.** No new surface. Both commands run behind the existing
`AuthContext` workspace scope. `retryCaptureUrl` requires the capture's
`created_by` or an owner role, matching conversion.

**Acceptance** (written before it passes; run against real Postgres):

1. Select two different paragraphs from one article, capture both → two captures,
   two distinct `content_hash` values.
2. Capture the same paragraph twice → one capture, second returns the first's id.
3. Capture a selection, let the fetch land → `text` still equals the selection,
   `fetched_text` holds the page.
4. Convert a selection capture to a document → `documents.source_url` equals the
   capture's URL.
5. Force a fetch failure, then `retryCaptureUrl` → a second `url_content_requested`
   event dispatches and `failure_reason` clears.
6. Fetch a 404 → outcome `error-page`, and `fetched_text` is not set.
7. Extension enqueue timeout → state `unconfirmed`, not `ok: true`.
8. Jev enabled with zero allowance → capture reaches `enriched` via the
   deterministic fallback and records that the paid tier was skipped.
9. `make check` passes.

---

## 5. Phase 2 — Connect saved inputs to ingestion

PR #2. Decisions taken here are settled; the concrete ticket is written when PR #1
merges.

- **File capture becomes a document.** `createFileCapture` creates a `documents`
  row referencing the existing `blob_id` and enqueues
  `document.extraction_requested`, in the same transaction as the capture.
  Quarantined files stay excluded. Capture still returns immediately — the work is
  outbox-backed, so "capture never blocks" holds. `intakeFile` already accepts
  `origin: "capture"`; the file path reuses the existing blob rather than
  re-uploading bytes.
- **Readiness is shown per stage, not as one word.** `enriched` is currently set
  by five different paths — deterministic-only, no model configured,
  unparseable model answer, full Tier 3, and the Jev path
  (`enrichment-handler.ts:204-211, 233-241, 260-266, 273-281, 391`). Spec §8.1
  requires `partially-extracted (visibly partial)`. Replace the single claim with
  the ladder the audit asks for: `Saved → Readable → Searchable → Claims
  proposed → Reviewed`. `enriched` stops meaning "the system understood this".
- **Honest partial coverage now.** The zettel extractor reads only the first
  12,000 characters (`src/integrations/zettels/extractor.ts:32,52`). Until
  section-aware extraction lands, a truncated pass is recorded and labelled
  `processed first 12,000 of N characters`. A partial pass never presents as whole.
- **Processing lag is visible.** The deployed cron runs the dispatcher once daily
  (`vercel.json:12-13`, `0 8 * * *`). A real worker exists —
  `scripts/outbox-worker.ts`, started by `make queue-up` (`Makefile:38-41`) — but
  it runs only where someone starts it, and it is not in `compose.yaml` or any
  deploy config. Either the deployed dispatcher runs more often or the surface
  stops promising near-term processing. Which of the two is a deployment decision
  to confirm before this ticket is written; the spec does not assume it.

## 6. Phase 3 — Processing correctness and cost

PR #3. All four items have confirmed code-level evidence.

1. **Decouple embeddings from zettels.** `ENRICHMENT_STAGES` is
   `["extract","embed","zettels","link"]` and the loop `break`s on first failure
   (`src/domains/knowledge/enrichment.ts:145-152`), so an embedding outage blocks
   zettel generation — which needs extracted text, not vectors. Split the graph:

   ```text
   extracted text ─┬─→ search embeddings
                   └─→ zettel proposals → accepted cards → card embeddings
   ```

2. **Stop paying for document embeddings twice.** On a fresh extraction
   `embedAfterText` calls `embedExtraction`, then the `embed` stage calls it again;
   `embedExtraction` has no pre-I/O existence check, unlike `embedArtifact`. One
   component owns the stage, or `embedExtraction` becomes idempotent before the
   provider call for a given extraction/model/chunking version.

3. **Key stage completion to the extraction version.** `document_enrichment` has
   no version column and is unique on `(document_id, stage)`, so a re-extraction
   inherits the prior extraction's completed `embed`/`zettels` stages and new text
   gets no new proposals. Zettel dedupe keys on `documentId+spanStart+spanEnd`
   rather than extraction id, so identical offsets in changed text collide.

4. **Fence the enrichment stages.** `runStage` writes `running` with no lease or
   compare-and-set, unlike document extraction (`claimedBy`) and capture
   enrichment (`enrichmentLeaseToken`). Add the same ownership token so two
   concurrent passes cannot both call the model.

## 7. Phase 4 — Section-aware extraction and the journey gate

PR #4, the largest single piece, with its own eval.

Replace the 12,000-character prefix with coverage:

```text
document structure → sections → candidate claims per section
  → merge overlapping candidates → select useful → verify evidence
  → record coverage
```

Evidence verification stays as strict as today: the quote verifier drops quotes
not found in the extraction. Coverage is added on top, so a card can no longer be
plausible-looking while missing the paper's conclusion.

**Release gate for the whole branch.** One end-to-end test of the journey the
audit names, replacing the current suite of helper-level checks:

> Capture two different selections from the same article, capture a PDF through
> the global capture input, close the client, restart a worker, recover from one
> provider failure, find both sources, generate claims from later sections,
> accept one, and navigate back to the exact original evidence.

Plus the invariant: a saved capture cannot quietly stop halfway while the
interface implies the system has it.

## 8. Smaller inconsistencies

Carried, not led with. Each lands in the phase whose files it touches.

| Finding | Phase | Evidence |
|---|---|---|
| Client-supplied `title` goes into `raw_payload` but not `captures.title` | 1 | `commands.ts` insert values |
| `{url}` request body becomes `kind: text` with the URL as its text, because `input.url` suppresses URL detection; the scraper is still enqueued, so only the initial kind is wrong | 1 | `route.ts:58`, `commands.ts:86,96,103` |
| `intakeFile` writes object storage before DB work without the capture path's cleanup catch | 2 | `intake.ts` vs `commands.ts` |
| Global search misses file captures and its results drop the capture id | 2 | `shell-actions.ts` → `searchWorkspace()` |
| Voice `failure_reason` not rendered in the normal voice body branch | 2 | `inbox-detail.tsx` |
| Provider-extracted fields not persisted for proposal retry | 2 | comment in `extraction.ts` |
| Inbox renders 4 of 9 proposal kinds (`task`,`note`,`contact`,`discard`); unknown kinds are silently dropped. The live producer emits only those 4, so this is a latent gap, not a user-visible one, until a fifth kind ships | 2 | `capture/schema.ts`, `inbox-detail.tsx:72-77, 317-318`, `jev-classify.ts:31` |

## 9. Coordination

Three parallel sessions share this repository. This branch must not collide:

| Session | Worktree / branch | Overlap |
|---|---|---|
| `axiom-9e` | `~/Projects/axiom`, `fix/ash-chat-transcript-and-capture-reply` | None on files. Reads `getTaskProvenance` in `knowledge/queries.ts` read-only — **do not move or rename it**. Owns `src/lib/navigation.ts` and all Work surfaces. |
| `axiom-4d` | same shared checkout | Owns `command-center/briefing/**` and the nav surfaces that link **into** `/command-center/inbox`. The inbox *route path* must not change, and the inbox *labels* it asserts on must not change without telling them. |
| `axiom-notebooklm-9c` | `~/Projects/axiom-notebooklm`, `notebooklm-2` | Plans to move `capture/draft-templates.ts` → `knowledge/templates.ts` and later add a nullable `captures.intent` column. **`intent` (why you saved it, mutable) is a different axis from `capture_mode` (what arrived, immutable)** — both columns stay, and both land in the same `convertCaptureToTask` transaction if `capture_mode` needs to survive conversion. |

All four sessions confirmed no file-level overlap on Phase 1's file set.

## 10. Diffs to `agents/` that this branch owes

`agents/architecture.md` known gaps 3 and 4 are partly stale. Gap 4 says "no path
sets a capture to `enriched`"; `enrichment-handler.ts` sets it on five paths and
`capture.enrichment_requested` is a registered outbox topic, so that sentence is
wrong today. Gap 3 ("`classifying` is never set, `capture_proposals` has no
producer") is half right: `classifying` is indeed never set, but
`jev-classify.ts` does produce proposals for four kinds.

Per `coding.md`, a behaviour change updates the doc that owns that behaviour, so
gaps 3–4 are corrected in the PR that touches them rather than left to drift
further.

## 11. Rollback

Every phase is a separate PR and reverts independently.

- Phase 1: the migration is additive except the index swap. Reverting the code
  while leaving `capture_mode`/`fetched_text`/`content_hash` in place is safe —
  old code ignores them. Reverting the index requires a follow-up migration that
  recreates `captures_workspace_source_url_key`; run it on a Neon branch first,
  since it can fail if duplicate rows were created under the new rules.
- Phases 2–4: no schema change beyond nullable columns and new stage columns;
  revert the commit.
