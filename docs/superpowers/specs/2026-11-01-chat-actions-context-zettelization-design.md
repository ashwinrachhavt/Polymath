# Chat actions, composer context, and engine-grade zettelization

**Date:** 2026-11-01
**Status:** approved design, not yet implemented
**Extends:** `2026-10-30-ideas-surface-design.md` (Ideas surface) and
`2026-10-29-polymath-zettel-sitting-design.md` (artifact-zettel lineage, acceptance boundary)

---

## Why

Three things are wrong or missing today.

**Chat shows sources that are not sources.** `citationsFromToolOutput`
(`src/domains/agents/stream-contract.ts:93`) promotes every row of any tool
result shaped `{results: [...]}` into a citation, and `chat-surface.tsx:414`
renders the Sources strip from that list. Nothing checks that the answer used
the passage. In the observed failure, the assistant correctly reported that
nothing in the library mentioned the person, and the same answer still carried
"Sources · 1" naming an unrelated article. The retrieval was fine; the
presentation lied.

**A conversation cannot become knowledge without leaving it.** The transcript
can be synced into the graph as one `transcript` artifact and a single answer
can be saved as a note, but there is no way to (a) annotate a message,
(b) save one message as an idea, or (c) turn part of a conversation into linked
ideas. Alfred had these; they did not survive the port. Alfred's chat comments
were never persisted (localStorage only), so this is new work, not a port.

**Capture zettelization silently truncates.** `proposeZettels` feeds
`extraction.text` to an extractor that slices to `MAX_INPUT_CHARS = 12_000`
(`src/integrations/zettels/extractor.ts`), and stops at
`MAX_ZETTELS_PER_DOCUMENT = 8`. A blog post longer than 12,000 characters loses
its remainder with no signal to anyone. Nothing compares a candidate against
ideas the corpus already holds, so running the pass twice on overlapping
sources stacks near-duplicate ideas that no later stage can merge.

Success looks like: every source under an answer is one the answer cites; a
message can be commented on, saved, or mined for ideas without leaving the
conversation; attaching a person, company, or idea is visible and reversible;
and zettelizing a long document reads all of it, reports what it could not
read, and does not mint a second copy of an idea that already exists.

---

## Decisions (owner, 2026-11-01)

| Question | Answer |
| --- | --- |
| Chat comment anchoring | Per message, whole-message. No text-anchor ranges. |
| Message send targets | Three separate buttons: save as note, save as idea, extract ideas. |
| Long-source zettelization | Deterministic chunk + merge pipeline, plus an Eve tool for on-demand use. |
| Neo4j | **Not restored.** Postgres already holds the graph. |
| New-idea linking | Semantic neighbours **plus** topic hubs. |
| "Idea loading" in chat | A removable chip above the composer whose text is sent as context. |
| "News feed" complaint | It is the Sources strip — the phantom-source bug. |

### Neo4j, settled

The graph is already in Postgres: `artifacts` nodes, `artifact_links` with the
eleven typed relations from `relation-vocabulary.ts` plus machine `semantic`
edges, pgvector embeddings, RRF hybrid retrieval (`retrieval.ts:100`), traversal
(`listCardGraph`), and a canvas at `/polymath/graph`. Neo4j would be a second
store that must never drift, turning every link write into a two-store
transaction. Neither axiom nor the Alfred donor ever used it; the 2026-10-29
spec deferred it as out of scope. If a real multi-hop query defeats Postgres, a
**read-only projection rebuilt from Postgres** is the way back in — never a
second source of truth.

---

## Scope

### In scope

1. Sources truthfulness in chat (a source is a passage the answer cites).
2. Message comments, persisted, per message.
3. Save a message as a note or as an idea; extract ideas from a message.
4. Composer context chips for people, companies and ideas.
5. A chunk + merge zettelization pipeline for long documents.
6. Corpus-aware deduplication at proposal time.
7. Topic hubs, link rationale, source staleness in the graph.
8. A `zettels_propose` Eve tool.

### Out of scope

- Neo4j, Qdrant, or any second graph/vector store.
- Cross-encoder reranking. New dependency and per-query latency for a
  retrieval quality problem we do not have; the hybrid RRF path is sufficient.
- New relation types (`mechanism_of`, `refines`). The existing eleven cover
  the same distinctions; `explains` and `extends` are the mapping.
- Agent-inferred relation types at ingest. More tokens per idea and more wrong
  edges for the owner to dismiss. Rationale is written on demand instead.
- Text-anchor comments on chat messages or notes. Both stay whole-object.
- Automatic merging of duplicate ideas. Dedup flags; the owner decides.
- Restoring sittings, cards, or areas.

---

## Ship shape: four PRs, one migration

Reduced from six stacked PRs. The two chat PRs merge (they rework the same
toolbar and composer) and the two zettelization PRs merge (they share one
proposals seam). One migration carries both tables and the seam, so there is no
stacked-schema rebase risk.

| PR | Contents | Depends on |
| --- | --- | --- |
| **A** | Sources truthfulness + `documents_search` relevance floor | — |
| **B** | `message_comments`, three message actions, composer context chips; migration 0269 | A |
| **C** | Proposals source seam, chunk + merge pipeline, corpus dedup, thread zettelization | B |
| **D** | Topic hubs, link rationale, staleness badge, `zettels_propose` Eve tool | C |

PR A is a bugfix and ships on its own if the rest stalls.

---

## Part 1 — A source is a passage the answer cites (PR A)

### The rule

The Sources strip renders exactly the passages the answer **cites** with a
`[[n]]` marker. Everything a retrieval returned but the answer did not use
stays in the tool pill, where it already renders, and disappears from the
"Sources" count.

### Why the fix lands at render, not at emit

Citations are emitted per tool result
(`stream-contract.ts:315`), which happens **before** the answer is written. The
server cannot know then which passages the answer will cite. The client can:
it holds both the answer text and the accumulated citation array, and
`inline-citations.ts` already parses the markers.

So the mechanism is:

1. `citationsFromToolOutput` keeps accumulating candidate passages (unchanged).
2. The answer's `[[n]]` markers are parsed with the existing
   `inline-citations.ts` logic to yield a set of cited indices.
3. The strip renders only citations whose index is in that set. Indices are
   1-based in the text and 0-based in the array — the existing
   `inline-citations.ts` comment names this exact trap.
4. **No markers means no strip.** A reply that cites nothing has no Sources.

`ChatCitation` gains no field; the change is a filter over an existing list,
which is why this is a bugfix rather than a redesign.

### The relevance floor

`documents_search` returns its best N regardless of quality, so a query with no
match still hands back the least-bad document. That is how an article about
something else became a "source".

- New named constant `AGENT_SEARCH_MIN_SCORE` in
  `src/domains/knowledge/agent-search.ts`. A passage scoring below it is
  dropped before the results leave the domain.
- When every passage is dropped, the tool returns an empty `results` array and
  sets an explicit reason so the agent states that nothing matched instead of
  narrating weak hits.
- The keyword leg's score is a rank, not a calibrated similarity; the floor
  applies to the fused score. A test pins the floor against a fixture pair
  (a genuine match and a known non-match) so the number is calibrated, not
  guessed.

### Files

| File | Change |
| --- | --- |
| `src/components/chat/chat-surface.tsx` | Derive cited indices from the answer; filter the strip. Extract the message toolbar into `message-actions.tsx` (it grows in PR B). |
| `src/components/chat/cited-text.tsx` | Expose the marker indices it already parses, so the surface can filter without a second parser. |
| `src/domains/knowledge/agent-search.ts` | `AGENT_SEARCH_MIN_SCORE`, filter, empty-with-reason. |
| `src/domains/agents/stream-contract.ts` | Unchanged emission; the citation frame keeps carrying candidates. |

### Tests

- An answer with no markers renders no Sources strip, though the tool pill
  still lists what retrieval returned. *(the reported bug)*
- An answer citing `[[2]]` of three candidate passages renders exactly one
  source, and it is the second.
- Duplicate indices (`[[1]] [[1]]`) render one source.
- A marker naming an index beyond the array is ignored, not a crash (the
  `inline-citations.ts` contract already drops it; the strip must agree).
- The relevance floor drops a known non-match and keeps a known match on the
  fixture corpus; an all-dropped result is empty with a reason, not an error.

---

## Part 2 — Message actions and composer context (PR B)

### 2.1 Message comments

New table `message_comments` (migration **0269**), mirroring `note_comments`
(0259) so the app has one comment idiom rather than two.

```
message_comments
  id            uuid pk
  workspace_id  uuid not null  -> workspaces(id) on delete cascade
  thread_id     uuid not null  -> threads(id)    on delete cascade
  message_id    uuid not null  -> messages(id)   on delete cascade
  body          text not null    check length(btrim(body)) between 1 and 2000
  resolved_at   timestamptz null
  created_by, updated_by uuid
  created_at, updated_at, archived_at, version
  index (workspace_id, message_id, created_at)
```

Rules carried over verbatim from `note-comments.ts`: resolve hides a comment
from the open count and never deletes it; every command is one transaction
(receipt → ownership check → change → audit); a comment never touches the
message or the run's version.

**Privacy.** The ASH-306 rule applies: a comment on a Supervisor thread
(`threads.subjectType === "supervisor"`) is visible only to
`threads.subjectId`. Deleting a message or thread cascades its comments.

Domain: `src/domains/agents/message-comments.ts`.

### 2.2 Three message actions

In the toolbar that `chat-surface.tsx:607` already renders, beside copy and
like/dislike:

| Action | What it writes | Reuses |
| --- | --- | --- |
| **Save as note** | A note artifact, citations as a numbered source list, `source` edge to the run | `saveAnswerAsNote` (`src/domains/knowledge/save-answer.ts`) |
| **Save as idea** | An artifact `kind: "zettel"` with the message as its body and a `source` edge | `createNoteInTx` + `linkCards` |
| **Extract ideas** | `zettel_proposals` rows for the message | The PR C pipeline; in PR B this button ships behind the seam landing in PR C |

Authorship is acceptance: saving a message as an idea is the owner's own act,
which is the acceptance-boundary rule from the 2026-10-29 spec (path 1). It
does **not** go through the proposal queue — only the model's extractions do.

### 2.3 Composer context chips

Today, picking a person silently rewrites the draft to `@Name` and remembers
the entity; the context JSON is fetched at send time and silently dropped if
the fetch fails; editing the name drops it silently; there are two divergent
pickers (the `+` menu and a bare `@`); and long profiles are quietly cut at
2,000 characters per record, 4,000 total.

Replaced with one visible mechanism:

- **Picking adds a chip** above the composer: glyph, name, kind, and a remove
  button. The chip is the record's identity — the draft text is untouched, so
  editing prose can never silently detach context.
- **Context fetches on pick**, not on send. A failure is visible immediately on
  the chip (error styling plus a retry), never as a send that quietly ran
  without context.
- **Send serializes already-fetched context.** No network at submit means no
  silent partial send. The existing `serializeMentionContext` /
  `stripMentionContext` / `fitMentionContext` contract is unchanged, so stored
  messages keep stripping correctly and the budget rules still hold.
- **Budget is visible.** When the total context budget truncates something, the
  chip says so rather than the payload quietly shrinking.
- **One picker.** The `+` menu becomes the only picker; a bare `@` opens it
  with the query seeded, so there is one code path and one set of results.

`MentionEntity` widens from `person | company` to `person | company | zettel`.

**What an idea chip sends:** title, claim (the current version's plain text,
first 600 characters), tags, and up to five linked ideas as
`{title, relation}` pairs using the existing relation labels. That is enough for
the model to reason about and cite the idea itself rather than a link it cannot
read.

### 2.4 Files

| File | Change |
| --- | --- |
| `src/domains/agents/message-comments.ts` | New, mirrors `note-comments.ts` |
| `src/domains/agents/schema.ts` | `messageComments` table |
| `src/db/migrations/0269_*.sql` | `message_comments` + the proposals seam (Part 3.1) |
| `src/components/chat/message-actions.tsx` | New: toolbar extracted out of `chat-surface.tsx` |
| `src/components/chat/message-comments.tsx` | New: chip + inline thread |
| `src/components/chat/context-chips.tsx` | New: the chip row and its states |
| `src/components/chat/chat-surface.tsx` | Orchestration only; drops the toolbar and mention state |
| `src/components/chat/composer-plus.tsx` | Single picker; `@` seeds the query |
| `src/components/chat/mention-context.ts` | `zettel` kind; serialize already-fetched context |
| `src/domains/knowledge/record-search.ts` | Idea results already exist; no change expected, verified at implementation |

### 2.5 Tests

- A comment on a message survives reload, resolves and un-resolves, and an
  empty or whitespace-only body is rejected.
- A comment on a Supervisor thread is invisible to another member.
- Deleting a thread cascades its comments and leaves nothing orphaned.
- Save-as-note and save-as-idea are idempotent under the same receipt key.
- Save-as-idea writes `kind: "zettel"` and a `source` edge to the run.
- Picking a person renders a chip and leaves the draft text unchanged.
- Removing a chip removes the context block from the outgoing payload.
- A failed context fetch shows an error on the chip and the send is blocked
  until the chip is retried or removed — never a silent send without context.
- An idea chip's payload carries title, claim, and at most five links.
- A message with no chips serializes byte-identically to today.

---

## Part 3 — Zettelization engine (PR C)

### 3.1 The source seam (migration 0269)

`zettel_proposals` today requires `document_id` and `extraction_id`, both NOT
NULL. Chat and artifact sources have neither. Rather than a second proposals
table, the table gains a source discriminator:

```
zettel_proposals
  document_id          uuid null   (was not null)
  extraction_id        uuid null   (was not null)
  source_artifact_id   uuid null   -> artifacts(id) on delete cascade   [new]
  duplicate_of_artifact_id uuid null -> artifacts(id) on delete set null [new]
  check (num_nonnulls(document_id, source_artifact_id) = 1)
```

**The uniqueness trap.** The existing unique index is
`(document_id, dedupe_key)`. Postgres treats NULLs as distinct in a unique
index, so with `document_id` nullable every artifact-sourced proposal would be
unconstrained — the dedupe guarantee would silently vanish exactly where it is
new. A second **partial** unique index is required:

```
create unique index "zettel_proposals_artifact_dedupe_key"
  on "zettel_proposals" ("source_artifact_id", "dedupe_key")
  where "source_artifact_id" is not null
```

The existing index (`zettel_proposals_dedupe_key`, migration 0012) is left
untouched.

**Source text resolution.** `locate()` verifies a quote is verbatim. It needs a
text to search. `proposeZettels` gains a resolver:

- `document_id` → the succeeded extraction text (today's behaviour)
- `source_artifact_id` → the artifact's `current_version_id` `plain_text`

The verbatim-evidence guarantee is unchanged on both paths: a quote not found
in the source is dropped, never cited.

The dedupe key becomes path-aware: `zettel:doc:<documentId>:<start>-<end>` for
documents, `zettel:artifact:<artifactId>:<start>-<end>` for artifacts. Existing
rows keep their current key format, so no backfill is needed.

### 3.2 Chunk + merge pipeline

Replaces the single truncated call.

1. **Split by heading.** Sections are cut on markdown heading boundaries, with
   paragraph boundaries as the fallback, and each section is capped at
   `ZETTEL_SECTION_MAX_CHARS = 12_000` — the extractor's existing cap, so a
   section is always fully read.
2. **Bound the work.** `ZETTEL_MAX_SECTIONS = 12`. A source needing more is
   **not** silently cut: the count of unread characters is returned with the
   proposals and shown in the review UI ("Read 96,000 of 142,000 characters —
   46,000 in 4 sections were not read").
3. **Extract per section** with the existing `ZettelExtractor` contract,
   unchanged. Each candidate carries its own quote and span, so evidence stays
   per-section and verbatim.
4. **Merge once**, over candidate **titles and claims only** — never the full
   text, so the merge call's input is bounded regardless of document size. The
   merge drops near-duplicates, ranks, and keeps at most
   `ZETTEL_MAX_PER_SOURCE = 20`. This replaces the flat
   `MAX_ZETTELS_PER_DOCUMENT = 8` cap, which existed because one call could not
   produce more; a merged pass legitimately can.
5. Every survivor keeps the quote and span it came from. The merge can drop a
   candidate but can never invent one, and can never rewrite a quote.

A source whose sections all yield nothing returns zero proposals with an
explicit reason, matching today's "zero is a normal answer" contract in
`runZettelGenerationRequested`.

### 3.3 Corpus-aware dedup

The property that keeps the corpus from filling with twins as it grows.

- Each surviving candidate's claim is embedded with the existing embedding
  provider.
- It is compared against **accepted** ideas in the workspace (artifacts of kind
  `zettel`) using the embeddings already maintained by `embedArtifact`.
- A candidate closer than `ZETTEL_DUPLICATE_MAX_DISTANCE` to an existing idea
  is stored with `duplicate_of_artifact_id` set. The review UI shows "already
  exists as *X*" beside that proposal, with a link.
- The threshold is **calibrated by test**, not chosen by feel: a fixture set of
  pairs the owner calls duplicates and pairs they call distinct pins the value.
  Initial value 0.15 (cosine distance), vs `SEMANTIC_EDGE_MAX_DISTANCE = 0.45`
  for "related" — a duplicate is a much tighter claim than a neighbour.
- Dedup **flags only**. Nothing merges itself, nothing is rejected
  automatically, and a flagged proposal can still be accepted if the owner
  disagrees.

### 3.4 Thread zettelization

The chat half of the engine, using the same seam and the same pipeline.

- A panel action on a conversation: zettelize **the whole thread**, or a
  **selected run of messages**.
- The selected messages are serialized with the existing
  `transcriptMarkdown` helper and stored as one note-kind artifact.

  **Why not `kind: "transcript"`.** `NoteKind` is `LINKABLE_KINDS | "transcript"
  | "document"`, but `record-search.ts` files transcript artifacts under
  "artifact", not "notes", so a thread-sourced idea's provenance card would
  read wrongly. A note-kind artifact is also what `syncThreadToGraph` already
  creates for a whole thread, so the two paths stay consistent — the
  difference is that this one holds only the selected messages.

  Proposals then point at that artifact through the seam.
- Re-zettelizing a thread dedupes against the thread's own earlier proposals
  first, then the corpus, so repeating the action does not stack twins.
- Nothing auto-accepts. The proposals land in the existing review queue the
  knowledge page already serves.

### 3.5 Files

| File | Change |
| --- | --- |
| `src/db/migrations/0269_*.sql` | The seam, the partial unique index, the check |
| `src/domains/knowledge/zettels.ts` | Source-agnostic `proposeZettels`, path-aware dedupe key, dedup lookup |
| `src/domains/knowledge/zettel-chunking.ts` | New: heading split, section bounds, overflow accounting |
| `src/domains/knowledge/zettel-merge.ts` | New: bounded merge pass |
| `src/integrations/zettels/extractor.ts` | Unchanged contract; merge prompt lives with the merge module |
| `src/domains/capture/zettel-generation.ts` | Reports read/unread characters |
| `src/domains/knowledge/thread-graph.ts` | Reused for transcript artifacts; no change expected |
| Proposal review UI | "already exists as *X*" and the unread-characters line |

### 3.6 Tests

- A 30,000-character document is fully read: every section appears in the
  extraction call log, and no section is truncated.
- A document over `ZETTEL_MAX_SECTIONS` reports its unread characters rather
  than silently dropping them.
- A candidate whose quote is not verbatim in its section is dropped, on both
  the document and the artifact path.
- The merge pass cannot introduce a candidate the extractors did not produce,
  and cannot alter a surviving quote.
- Two proposals from the same artifact with the same span collide on the
  partial unique index (the NULL-distinctness regression test).
- A candidate near an existing accepted idea is flagged `duplicate_of`; one
  that is merely related is not; accepting a flagged proposal still works.
- Zettelizing a thread twice produces no second set of proposals for the same
  messages.
- Zettelizing a subset of messages cites only those messages' text.

---

## Part 4 — Graph hygiene and the Eve tool (PR D)

### 4.1 Topic hubs

The "reachable from many topics" property, as real edges rather than decoy
ideas.

- One hub artifact per canonical topic from `taxonomy_nodes` level 1 (the seed
  catalog of 22 domains). Created lazily on first use.
- Hubs are `kind: "other"` so they never appear in the Ideas list, which
  filters on `note`/`zettel`.
- An idea filed under a topic gets a `part_of` edge to its hub. `part_of` is
  already in `RELATION_TYPES`, so no vocabulary change.
- Hub edges give a new idea bounded multi-topic reach — at most the topics it
  is actually filed under — while semantic neighbours give it depth. Neither
  is unbounded, so the canvas stays legible.
- Hub artifacts are excluded from the semantic-edge pass, so hubs never become
  each other's neighbours and a hub is never suggested as a "related idea".

### 4.2 Link rationale, on demand

`artifact_links.context` exists and is never populated. When the owner opens a
suggested link, one generation call writes the sentence that justifies it
("This qualifies 'Retries improve reliability': retries are safe only when
duplicate effects are controlled.") and stores it in `context`.

Ingest stays free: no rationale is generated for links nobody looks at, which
is the difference between this and a per-edge model cost.

### 4.3 Source staleness

When a source document's successful extraction changes, ideas derived from it
carry `metadata.sourceChangedAt` (the namespaced-write rule from §16.8 of the
2026-10-29 spec: merge by namespace, never a whole-object read-modify-write,
and never bumping `updated_at`).

Surfaced in two places that already exist: a badge on the idea, and the
knowledge-debt report (`src/domains/knowledge/debt.ts`), which is exactly the
"where is the library decaying" surface this belongs in.

Nothing rewrites an idea automatically. A stale idea is a prompt to look, not a
queue item.

### 4.4 `zettels_propose` Eve tool

`eve/polymath/agent/tools/zettels_propose.ts`, following the shape of the
existing propose tools (`tasks_propose`, `artifacts_propose_revision`):

- Input: the text or artifact to mine, a stable dedupe id.
- Output: proposal ids, and whether each was flagged as a duplicate.
- It **proposes**. It never accepts, never creates an idea artifact directly,
  and never claims an idea exists. The instruction mirrors the existing wording:
  the proposal waits in the owner's review queue.
- Gated on a capability in the run's frozen policy snapshot, like every other
  tool.

### 4.5 Tests

- Hubs are created once per topic under concurrent first use.
- Hubs never appear in the Ideas list, are excluded from semantic edges, and
  never receive a `semantic` edge.
- An idea filed under two topics has two `part_of` hub edges.
- Rationale is written only when requested and is stored in `context`.
- A changed extraction marks derived ideas stale without touching
  `updated_at`; the debt report counts them.
- `zettels_propose` refuses when the capability is absent from the policy
  snapshot, and creates no artifact on its own.

---

## Risks and their handling

**PR A changes what users see under answers.** Sources may become rarer, which
could read as a regression. Mitigated by the tool pill still listing what
retrieval returned, and by the strip only ever claiming what the answer stood
on. This is the honest direction.

**The dedupe threshold can be wrong in either direction.** Too tight duplicates
slip through; too loose distinct ideas get flagged. Mitigated by calibration
tests over owner-labelled pairs, and by flags being non-blocking — a wrong flag
costs one dismissed suggestion, not a lost idea.

**Merge can drop good candidates.** Bounded by keeping per-section extraction
results in the review UI even when the merge discards them, so a dropped
candidate is inspectable rather than gone.

**The proposals seam is a nullable-FK migration on a live table.** The check
constraint `num_nonnulls(...) = 1` plus the partial unique index are both
additive; `document_id` and `extraction_id` relax from NOT NULL to NULL, which
is backwards-compatible. Existing rows satisfy the constraint as written.
Deploy order: migration, then code (the reverse of a destructive drop, and safe
because relaxing a constraint cannot break old readers).

**Chat surface growth.** `chat-surface.tsx` is 668 lines and gains a chip row.
The toolbar and comment panel move to their own modules in PR B rather than
letting the file grow.

---

## Definition of done

- An answer's Sources strip contains only passages it cites. *(the reported bug)*
- A message can be commented on, saved as a note, saved as an idea, or mined
  for ideas.
- Picking a person, company, or idea is visible, removable, and fails loudly.
- A 100,000-character document is read in full or reports exactly what it could
  not read.
- A proposal that duplicates an accepted idea is flagged with a link to it.
- Ideas are reachable through their topic hubs as well as their neighbours.
- `grep -rn "neo4j" src docs` returns only this spec's decision record.
