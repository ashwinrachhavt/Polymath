# Chat Actions, Composer Context, and Engine-Grade Zettelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make chat sources truthful (only passages the answer cites), let a message be commented on, saved, and mined for ideas without leaving the conversation, and replace the truncating one-call zettelizer with a chunk + merge + dedup pipeline.

**Architecture:** Four shippable PRs over one migration. PR A is a render-time filter plus a relevance floor on document search. PR B adds `message_comments`, three message actions, and replaces the silent @-mention mechanism with visible composer chips. PR C makes `zettel_proposals` source-agnostic through a nullable-FK seam and drives a heading-split / per-section-extract / merge pipeline through it. PR D adds topic hubs, on-demand link rationale, source staleness, and the `zettels_propose` Eve tool.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM + Postgres (pgvector), Tailwind, Vitest (unit / ui / db projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-11-01-chat-actions-context-zettelization-design.md`

## Global Constraints

- Neo4j, Qdrant, or any second graph/vector store is **not** added. `grep -rn "neo4j" src docs` returns only the spec's decision record.
- No new relation types. `RELATION_TYPES` stays the existing eleven; `part_of` and `source` are already present.
- No cross-encoder reranking and no new npm dependency.
- Comments are whole-message only. No text-anchor spans on messages or notes.
- Nothing auto-accepts and nothing auto-merges. Dedup flags; the owner decides.
- Every migration is additive: no published `.sql` file is edited, and `pnpm check:migrations` passes.
- One migration, `0269`, carries `message_comments` **and** the `zettel_proposals` seam. It lands with PR B; PR C adds no migration.
- Component files stay under 200 lines; `chat-surface.tsx` (668 lines) must not grow — the toolbar moves out.
- Every command is one transaction in the order receipt → ownership check → change → audit.
- Tenant scoping is always `auth.workspaceId` from the verified session, never a model argument.
- Copy is sentence case, plain verbs. No "recall", "mastery", "learning loop".
- Tests run `pnpm test:ci` (not `pnpm test`) before any claim that a suite is green.

## Review Focus

- **A reply that cites nothing still has retrieval results from the tool pill.** Expectation: the Sources strip is absent entirely, and the tool pill is unchanged. If the strip renders "Sources · 1" here, the reported bug is not fixed.
- **`documents_search` runs with no embedding provider configured** (`mode: "text"`, one leg only). Expectation: results still come back; a relevance floor tuned for two legs must not empty the list.
- **A conversation whose messages failed to mirror** (bridge down, or a live run whose turn has not completed). Expectation: the comment control is absent with a reason; save-as-note and save-as-idea still work from the block text, never attaching a comment to a guessed message.
- **A document longer than `ZETTEL_MAX_SECTIONS` sections.** Expectation: the review UI states how many characters were not read; nothing is truncated silently.
- **The zettelizer runs twice over overlapping sources.** Expectation: the second proposal carries `duplicate_of_artifact_id` and the UI names the existing idea, rather than a twin appearing in the library.

---

## Task 1: Cited-index extraction (PR A)

**Files:**
- Modify: `src/domains/knowledge/inline-citations.ts`
- Test: `tests/unit/inline-citations.test.ts` (append)

**Interfaces:**
- Consumes: `splitCitations` (existing), `DocumentCitation` (`@/domains/knowledge/agent-search`).
- Produces: `citedIndices(answer: string, citations: DocumentCitation[]): number[]` — 0-based indices into `citations`, deduplicated, ascending, containing only indices a marker actually resolves to.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/inline-citations.test.ts`:

```ts
import { citedIndices } from "@/domains/knowledge/inline-citations";

describe("citedIndices", () => {
  const three = [citation(A, 0), citation(B, 5), citation("33333333-3333-4333-8333-333333333333", 9)];

  it("returns no indices when the answer cites nothing", () => {
    expect(citedIndices("Nothing in the library mentions that person.", three)).toEqual([]);
  });

  it("returns the single index a [[2]] marker names, 0-based", () => {
    expect(citedIndices("The ramp holds [[2]].", three)).toEqual([1]);
  });

  it("deduplicates a repeated marker", () => {
    expect(citedIndices("One [[1]] and again [[1]].", three)).toEqual([0]);
  });

  it("ignores a marker past the end of the array", () => {
    expect(citedIndices("Beyond the list [[9]].", three)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/inline-citations.test.ts`
Expected: FAIL — `citedIndices` is not exported.

- [ ] **Step 3: Implement `citedIndices` in `src/domains/knowledge/inline-citations.ts`**

Reuse `splitCitations` rather than a second regex, so the strip and the prose can never disagree about which markers resolve. Collect `segment.index` from `type === "citation"` segments, dedupe, sort ascending.

The spec's file table names `cited-text.tsx` as the place to expose these. Put them in `inline-citations.ts` instead: it is the module that already owns the parse, it stays pure and unit-testable without a DOM, and `CitedText` (a client component) would otherwise be the only way to ask the question. `cited-text.tsx` needs no change.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/inline-citations.test.ts`
Expected: PASS, 4 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/inline-citations.ts tests/unit/inline-citations.test.ts
git commit -m "feat(citations): expose the indices an answer actually cites"
```

---

## Task 2: Sources strip renders only cited passages (PR A)

**Files:**
- Modify: `src/components/chat/chat-surface.tsx:414-448`
- Test: `tests/unit/chat-surface-citations.test.ts` (append)

**Interfaces:**
- Consumes: `citedIndices` (Task 1); `chat.citations` (existing `ChatState`).
- Produces: nothing consumed later. The strip's behaviour is the deliverable.

**The design decision this task locks in.** `chat.citations` accumulates every candidate passage a tool returned, because emission happens before the answer is written. The strip computes `const cited = new Set(citedIndices(lastText ?? "", chat.citations))` and renders `chat.citations.filter((_, i) => cited.has(i))`. With no markers `cited` is empty, so no `Details` element renders at all — not an empty one. `ChatCitation` gains no field.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/chat-surface-citations.test.ts`. The existing file's `stateWith(citations)` helper returns `blocks: []`; use a `stateWithAnswer(text, citations)` helper that sets one assistant block:

```ts
function stateWithAnswer(text: string, citations: ChatState["citations"]): () => ChatState {
  return () => ({
    blocks: [{ id: "assistant:turn_0:0", kind: "assistant", text, done: true }],
    tools: [],
    citations,
    connection: "streaming",
    error: null,
    retryable: true,
    lastFailedTurn: false,
    runFailed: false,
  });
}

describe("ChatSurface sources truthfulness", () => {
  it("renders no Sources strip when the answer cites nothing", () => {
    mockChatState = stateWithAnswer("Nothing in the library mentions that person.", [passage("doc-a", "Unrelated article", 0)]);
    const html = renderToStaticMarkup(createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }));
    expect(html).not.toContain("Sources ·");
    expect(html).not.toContain("Unrelated article");
  });

  it("renders exactly the passage a [[2]] marker names", () => {
    mockChatState = stateWithAnswer("The ramp holds [[2]].", [
      passage("doc-a", "First", 0),
      passage("doc-b", "Second", 0),
      passage("doc-c", "Third", 0),
    ]);
    const html = renderToStaticMarkup(createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }));
    expect(html).toContain("Sources · 1");
    expect(html).toContain("Second");
    expect(html).not.toContain("Third");
  });

  it("renders one source for a duplicated marker", () => {
    mockChatState = stateWithAnswer("One [[1]] and again [[1]].", [passage("doc-a", "Only", 0)]);
    const html = renderToStaticMarkup(createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }));
    expect(html).toContain("Sources · 1");
  });

  it("ignores a marker past the end of the candidate list", () => {
    mockChatState = stateWithAnswer("Beyond the list [[9]].", [passage("doc-a", "Only", 0)]);
    const html = renderToStaticMarkup(createElement(ChatSurface, { runId: "run-1", subject: { type: "project", id: "d1" } }));
    expect(html).not.toContain("Sources ·");
  });
});
```

Note: the two pre-existing tests in this file ("counts documents, not passages…" and "lists distinct titles…") use `stateWith` with `blocks: []`. Those answers cite nothing, so under the new rule they render no strip. **Update both to use `stateWithAnswer` with a marker** — e.g. `"The answer [[1]]."` for the first and `"Both [[1]] and [[2]].`"` for the second — so they keep asserting the per-document counting rule they were written for.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/chat-surface-citations.test.ts`
Expected: FAIL — the first case still contains "Sources · 1".

- [ ] **Step 3: Filter the strip in `src/components/chat/chat-surface.tsx`**

Above the return, derive the cited list once per render:

```ts
const cited = new Set(citedIndices(lastText ?? "", chat.citations));
const shownCitations = chat.citations.filter((_, index) => cited.has(index));
```

Replace the strip's guard `chat.citations.length > 0` with `shownCitations.length > 0`, and every `chat.citations` inside the strip block (the document count, the title join, and `.map`) with `shownCitations`. Leave the `<li>` key and `id={`citation-${index}`}` numbering alone — the index must stay the position in `shownCitations`, which is what `CitedText` anchors to via `citedIndices`-derived order. Add a one-line comment saying the strip renders cited passages only, and that the uncited ones stay in the tool pill.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/chat-surface-citations.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/chat-surface.tsx tests/unit/chat-surface-citations.test.ts
git commit -m "fix(chat): sources strip lists only the passages the answer cites"
```

---

## Task 3: Relevance floor on agent search (PR A)

**Files:**
- Modify: `src/domains/knowledge/agent-search.ts`
- Test: `tests/unit/agent-search-rrf.test.ts` (append), `tests/unit/agent-search-min-score.test.ts` (create)

**Interfaces:**
- Consumes: `rrfMerge` (existing), `searchChunks`, `searchChunksFts` (`./search`).
- Produces:
  - `AGENT_SEARCH_MIN_SCORE = 0.5`
  - `type ScoredHit = ChunkHit & { fusedScore: number }`
  - `rrfMerge(ftsHits, vectorHits, limit, input?: { legsRun?: number }): ScoredHit[]`
  - `AgentSearchResult`'s ok branch gains `reason?: "no_relevant_passages"`.
  - `fusedScore` is normalized to `(0, 1]`: `(K / legsRun) × Σ_legs 1/(K + rank_leg)`.

**The trap this task defuses.** A raw-RRF floor silently empties `mode: "text"`, where only one leg runs and every score is at most `1/K`. Normalizing by `legsRun` puts both modes on one 0–1 scale: rank 0 on every leg scores 1.0, rank 0 on one of two legs scores 0.5, and one leg's rank-9 hit scores `60/69 ≈ 0.87`. The floor of 0.5 therefore means "both legs agree, or a single leg ranks it first" in hybrid mode, and in text mode it drops nothing a `@@` match already admitted — which is the honest behaviour, since FTS has already refused non-matches.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/agent-search-min-score.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AGENT_SEARCH_MIN_SCORE, rrfMerge } from "@/domains/knowledge/agent-search";
import type { ChunkHit } from "@/domains/knowledge/search";

const hit = (id: string): ChunkHit => ({
  documentId: id, title: id, extractionId: `ex-${id}`, chunkIndex: 0,
  text: `text of ${id}`, span: { start: 0, end: 10, page: null }, distance: 0,
});

describe("AGENT_SEARCH_MIN_SCORE", () => {
  it("is the calibrated 0.5 and sits on the normalized 0-1 fused scale", () => {
    expect(AGENT_SEARCH_MIN_SCORE).toBe(0.5);
  });

  it("keeps a genuine match both legs agree on and drops a keyword-only non-match", () => {
    // The genuine match is found by both legs near the top; the non-match shares
    // a stem with the query so only the keyword leg returns it, at rank 4.
    const fts = [hit("genuine"), hit("x1"), hit("x2"), hit("x3"), hit("non-match")];
    const vector = [hit("genuine"), hit("v1")];
    const merged = rrfMerge(fts, vector, 10, { legsRun: 2 });
    const score = (id: string) => merged.find((h) => h.documentId === id)!.fusedScore;
    expect(score("genuine")).toBeGreaterThanOrEqual(AGENT_SEARCH_MIN_SCORE);
    expect(score("non-match")).toBeLessThan(AGENT_SEARCH_MIN_SCORE);
  });

  it("keeps every text-mode hit, because one leg cannot outvote itself", () => {
    const merged = rrfMerge([hit("a"), hit("b"), hit("c")], [], 3, { legsRun: 1 });
    expect(merged.every((h) => h.fusedScore >= AGENT_SEARCH_MIN_SCORE)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/agent-search-min-score.test.ts`
Expected: FAIL — `AGENT_SEARCH_MIN_SCORE` is not exported.

- [ ] **Step 3: Normalize the fused score in `rrfMerge`, add the constant and the filter**

In `src/domains/knowledge/agent-search.ts`:
- Export `const AGENT_SEARCH_MIN_SCORE = 0.5;` with a comment giving the normalization formula and what 0.5 means in each mode.
- Change `rrfMerge`'s accumulator to record `fusedScore`, defaulting `legsRun` to `ftsHits.length && vectorHits.length ? 2 : 1`, and multiply the summed RRF by `RRF_K / legsRun`.
- In `searchDocumentsForAgent`, after `hits` is chosen, assign `legsRun = mode === "hybrid" ? 2 : 1` and filter `hits.filter((h) => h.fusedScore >= AGENT_SEARCH_MIN_SCORE)`.
- On the ok branch, when the filtered list is empty, add `reason: "no_relevant_passages"` to the returned object. Keep `results: []` — never an error.

Update the doc comment at the top of the module: a passage below the floor is not evidence, so it does not leave the domain.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/agent-search-min-score.test.ts tests/unit/agent-search-rrf.test.ts`
Expected: PASS. The existing `rrfMerge` tests still pass because the extra `fusedScore` field does not change ordering; if any assertion uses `toEqual` on whole objects, extend it with `fusedScore` via `expect.objectContaining`.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/agent-search.ts tests/unit/agent-search-min-score.test.ts tests/unit/agent-search-rrf.test.ts
git commit -m "feat(search): drop passages below a calibrated relevance floor"
```

---

## Task 4: The tool reports an empty result as a reason (PR A)

**Files:**
- Modify: `eve/polymath/agent/tools/documents_search.ts`
- Test: `tests/unit/documents-search-tool.test.ts` (create)

**Interfaces:**
- Consumes: `AgentSearchResult` with `reason` (Task 3).
- Produces: nothing later. The deliverable is the model-visible instruction.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/documents-search-tool.test.ts`. Import the tool module's exported default and assert its `description` names the empty case; a full execute test is not possible here (it needs a session), so this pins the one thing that changes:

```ts
import { describe, expect, it } from "vitest";
import tool from "../../eve/polymath/agent/tools/documents_search";

describe("documents_search description", () => {
  it("tells the model that an empty result means nothing matched", () => {
    expect(tool.description).toMatch(/empty results/i);
    expect(tool.description).toMatch(/nothing .*matched|no relevant/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/documents-search-tool.test.ts`
Expected: FAIL — the description says nothing about empty results.

- [ ] **Step 3: Extend the tool description**

Add one sentence to the existing description string, containing the words "empty results" and "nothing matched", stating that when `results` is empty the library holds nothing relevant and the answer must say so plainly rather than narrating a weak hit. Leave the tool's inputs and authorization path untouched.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/documents-search-tool.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eve/polymath/agent/tools/documents_search.ts tests/unit/documents-search-tool.test.ts
git commit -m "feat(agent): documents_search states the empty result as a reason"
```

---

## Task 5: Extract the message toolbar (PR A)

**Files:**
- Create: `src/components/chat/message-actions.tsx`
- Modify: `src/components/chat/chat-surface.tsx` (remove `MessageToolbar`, import the new one)
- Test: `tests/unit/message-actions.test.tsx` (create)

**Interfaces:**
- Consumes: `MessageFeedback` (`./message-feedback`), `turnIdOf` behaviour.
- Produces: `MessageActions({ runId, turnId, text, messageId, onComment }: { runId: string; turnId: string; text: string; messageId?: string | null; onComment?: () => void })` — a pure presentational toolbar. PR B adds two buttons inside it; this task moves the file so that growth never touches `chat-surface.tsx`.

- [ ] **Step 1: Write the failing test**

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageActions } from "@/components/chat/message-actions";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

describe("MessageActions", () => {
  it("renders copy and feedback for a finished answer", () => {
    const html = renderToStaticMarkup(createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer" }));
    expect(html).toContain('aria-label="Copy"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/message-actions.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Move the toolbar**

Move `MessageToolbar` out of `chat-surface.tsx` verbatim into `src/components/chat/message-actions.tsx`, renamed `MessageActions`, keeping its doc comment. It keeps `"use client"`. `messageId` and `onComment` are accepted now and simply unused; PR B renders them. In `chat-surface.tsx`, import `MessageActions` and call it with the same three props it uses today (`runId`, `turnId`, `text`) plus `messageId={block.messageId ?? null}` — which is `undefined` until Task 12 adds the field to `ChatBlock`, so pass nothing there yet and let Task 12 add it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/message-actions.test.tsx tests/unit/chat-surface-citations.test.ts`
Expected: PASS, and `chat-surface.tsx` is now under 620 lines.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/message-actions.tsx src/components/chat/chat-surface.tsx tests/unit/message-actions.test.tsx
git commit -m "refactor(chat): move the message toolbar into its own module"
```

---

## Task 6: `message_comments` table and the proposals seam (PR B)

**Files:**
- Modify: `src/domains/agents/schema.ts` (add `messageComments`)
- Modify: `src/domains/knowledge/schema.ts:1126-1159` (`zettelProposals` relaxes and gains two columns)
- Create: `src/db/migrations/0269_message_comments_and_proposal_sources.sql`
- Modify: `src/db/migrations/meta/_journal.json`
- Test: `tests/migration/0269-proposal-seam.test.ts` (create)

**Interfaces:**
- Produces:
  - `messageComments` with columns `id, workspaceId, threadId, messageId, body, resolvedAt, createdBy, updatedBy, createdAt, updatedAt, archivedAt, version`.
  - `zettelProposals.documentId: uuid | null`, `.extractionId: uuid | null`, `.sourceArtifactId: uuid | null`, `.duplicateOfArtifactId: uuid | null`.
  - Partial unique index `zettel_proposals_artifact_dedupe_key` on `(source_artifact_id, dedupe_key) where source_artifact_id is not null`.

**The trap, restated for the migration author.** Postgres treats NULLs as distinct in a unique index, so once `document_id` is nullable the existing `(document_id, dedupe_key)` index stops constraining artifact-sourced rows. The partial unique index is what restores the guarantee. Do not touch `zettel_proposals_dedupe_key` (migration `0012`).

- [ ] **Step 1: Write the failing test**

Create `tests/migration/0269-proposal-seam.test.ts`, following the `makeTestDb` / `ownerAuth` / `seedWorkspace` shape in `tests/integration/artifacts-list.test.ts`:

```ts
it("rejects a second proposal for the same artifact span", async () => {
  // Two inserts with the same source_artifact_id and dedupe_key must collide:
  // without the partial index, NULL document_id makes both rows distinct.
  await expect(insertProposal({ artifactId, dedupeKey: "zettel:artifact:a:0-20" })).resolves.toBeDefined();
  await expect(insertProposal({ artifactId, dedupeKey: "zettel:artifact:a:0-20" })).rejects.toThrow();
});

it("refuses a row naming both a document and an artifact", async () => {
  await expect(insertProposal({ documentId, artifactId, dedupeKey: "k" })).rejects.toThrow();
});

it("keeps document-sourced proposals unique on their own key", async () => {
  await expect(insertProposal({ documentId, dedupeKey: "zettel:doc:d:0-20" })).resolves.toBeDefined();
  await expect(insertProposal({ documentId, dedupeKey: "zettel:doc:d:0-20" })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project db tests/migration/0269-proposal-seam.test.ts`
Expected: FAIL — the columns and index do not exist.

- [ ] **Step 3: Write the migration and the schema**

`0269_message_comments_and_proposal_sources.sql`, in this order:
1. `CREATE TABLE IF NOT EXISTS "message_comments"` with the FK block and index copied from `0259_note_comments.sql`'s idiom (`DO $$ ... EXCEPTION WHEN duplicate_object THEN null`), body check `length(btrim(body)) between 1 and 2000`, and `CREATE INDEX IF NOT EXISTS "message_comments_message_idx" ON "message_comments" USING btree ("workspace_id","message_id","created_at")`.
2. `ALTER TABLE "zettel_proposals" ALTER COLUMN "document_id" DROP NOT NULL;` and the same for `"extraction_id"`.
3. `ALTER TABLE "zettel_proposals" ADD COLUMN IF NOT EXISTS "source_artifact_id" uuid;` with its FK to `artifacts(id) ON DELETE cascade`, and `"duplicate_of_artifact_id" uuid` referencing `artifacts(id) ON DELETE set null`.
4. `ALTER TABLE "zettel_proposals" ADD CONSTRAINT "zettel_proposals_one_source_check" CHECK (num_nonnulls(document_id, source_artifact_id) = 1);`
5. `CREATE UNIQUE INDEX IF NOT EXISTS "zettel_proposals_artifact_dedupe_key" ON "zettel_proposals" ("source_artifact_id","dedupe_key") WHERE "source_artifact_id" IS NOT NULL;`

Append a journal entry with `idx: 269`, `tag: "0269_message_comments_and_proposal_sources"`, and a `when` greater than the `0268` entry's.

Mirror both changes in the Drizzle schema files: `messageComments` in `src/domains/agents/schema.ts` next to `threadCheckpoints`, and the relaxed/added columns plus `.where(sql\`source_artifact_id is not null\`)` partial index and the `check` in `zettelProposals`.

- [ ] **Step 4: Run the test and the migration guard**

Run: `npx vitest run --project db tests/migration/0269-proposal-seam.test.ts && pnpm check:migrations`
Expected: PASS, and `check-migrations` reports no errors.

- [ ] **Step 5: Commit**

```bash
git add src/db/migrations/0269_message_comments_and_proposal_sources.sql src/db/migrations/meta/_journal.json src/domains/agents/schema.ts src/domains/knowledge/schema.ts tests/migration/0269-proposal-seam.test.ts
git commit -m "feat(db): message comments table and source-agnostic zettel proposals"
```

---

## Task 7: `message-comments` domain (PR B)

**Files:**
- Create: `src/domains/agents/message-comments.ts`
- Test: `tests/unit/message-comment-body.test.ts` (create), `tests/integration/message-comments.test.ts` (create)

**Interfaces:**
- Consumes: `withReceipt`, `recordAudit`, `withTransaction`, `threads`/`messages` from `./schema`, `users` from `@/domains/identity/tables`.
- Produces:
  - `class MessageCommentError extends Error` with `code = "message_comment_invalid"`.
  - `const messageCommentBody` — Zod string, max 2000, trimmed, min 1.
  - `listMessageComments(auth, messageId): Promise<MessageCommentItem[]>`
  - `addMessageComment(auth, input: { idempotencyKey?: string; messageId: string; body: string }): Promise<MessageCommentItem>`
  - `resolveMessageComment(auth, input: { idempotencyKey?: string; commentId: string; resolved: boolean }): Promise<{ id: string; resolvedAt: Date | null }>`
  - `type MessageCommentItem = { id: string; body: string; resolvedAt: Date | null; createdAt: Date; authorName: string | null }`

Every function resolves ownership by joining `messageComments → messages → threads` and filtering `workspaceId = auth.workspaceId`. `listMessageComments` and `addMessageComment` additionally throw `MessageCommentError` when `threads.subjectType === "supervisor" && threads.subjectId !== auth.userId` — the ASH-306 rule that `getConversation` already applies.

- [ ] **Step 1: Write the failing unit test**

Create `tests/unit/message-comment-body.test.ts`, mirroring `tests/unit/note-comment-body.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { messageCommentBody } from "@/domains/agents/message-comments";

describe("messageCommentBody", () => {
  it("trims surrounding whitespace", () => {
    expect(messageCommentBody.parse("  Worth keeping.  ")).toBe("Worth keeping.");
  });
  it("refuses blank and whitespace-only input", () => {
    expect(messageCommentBody.safeParse("   ").success).toBe(false);
    expect(messageCommentBody.safeParse("").success).toBe(false);
  });
  it("holds 2000 characters and refuses 2001", () => {
    expect(messageCommentBody.safeParse("x".repeat(2000)).success).toBe(true);
    expect(messageCommentBody.safeParse("x".repeat(2001)).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/message-comment-body.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domains/agents/message-comments.ts`**

Copy the structure of `src/domains/knowledge/note-comments.ts` line for line, with these deltas only: the ownership table is the `messages → threads` join rather than `artifacts`; the Supervisor privacy check is added to the read and the add; the audit actions are `agent.message_comment_added`, `agent.message_comment_resolved`, `agent.message_comment_reopened` with `subjectType: "message"`.

- [ ] **Step 4: Run the unit test, then write the integration test**

Run: `npx vitest run tests/unit/message-comment-body.test.ts` — PASS.

Create `tests/integration/message-comments.test.ts` against real Postgres with these four cases, each seeding a run and thread through the existing helpers:

```ts
it("persists a comment, resolves it, and reopens it", async () => { /* add -> list sees it open; resolve -> resolvedAt set, still listed; reopen -> null */ });
it("refuses an empty or whitespace-only body", async () => { /* rejects with MessageCommentError */ });
it("hides a Supervisor thread's comment from another member", async () => { /* list/add with a second user's auth throws MessageCommentError */ });
it("cascades comments when the thread is deleted", async () => { /* delete thread row, count message_comments for the message is 0 */ });
```

- [ ] **Step 5: Run the integration test**

Run: `npx vitest run --project db tests/integration/message-comments.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domains/agents/message-comments.ts tests/unit/message-comment-body.test.ts tests/integration/message-comments.test.ts
git commit -m "feat(chat): persisted per-message comments with supervisor privacy"
```

---

## Task 8: Resolve a rendered block to its stored message (PR B)

**Files:**
- Modify: `src/domains/agents/queries.ts` (add `listRunMessageIds`)
- Modify: `src/domains/agents/stream-contract.ts` (`StoredMessage.messageId`, `threadBlocks`)
- Modify: `src/app/(workspace)/polymath/[runId]/page.tsx`
- Test: `tests/unit/thread-blocks-message-id.test.ts` (create)

**Interfaces:**
- Consumes: `messages` table, `run_events`-derived `ThreadEntry[]`.
- Produces:
  - `listRunMessageIds(workspaceId: string, runId: string): Promise<string[]>` — mirrored `messages.id`s for the run, oldest first.
  - `ChatBlock` gains `messageId?: string | null`.
  - `StoredMessage` gains `messageId?: string | null`, and `threadBlocks` copies it onto the block.

**The design decision this task locks in.** The chat surface renders `run_events`, whose block ids (`assistant:<turnId>:0`, `user:stored:<sequence>`) are not `messages.id`. The Zoe bridge mirrors every rendered message into `messages`, but a guarded mirror can fail, so the two lists can disagree. The plan's rule: **pair by index only when the counts match; otherwise leave every `messageId` null.** A null `messageId` hides the comment control (Task 11) and never guesses — attaching a comment to the wrong message is worse than not offering one. Save-as-note and save-as-idea do not need a message id, so they keep working.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { threadBlocks } from "@/domains/agents/stream-contract";

describe("threadBlocks message ids", () => {
  it("copies the stored message id onto its block", () => {
    const blocks = threadBlocks([{ sequence: 1, role: "assistant", text: "Hi", turnId: "t1", messageId: "m1" }]);
    expect(blocks[0].messageId).toBe("m1");
  });
  it("leaves it null when the run has no mirrored message", () => {
    const blocks = threadBlocks([{ sequence: 1, role: "user", text: "Q", messageId: null }]);
    expect(blocks[0].messageId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/thread-blocks-message-id.test.ts`
Expected: FAIL — `messageId` is not on the block.

- [ ] **Step 3: Thread the field through**

Add the optional field to `ChatBlock` and `StoredMessage`, and set `messageId: message.messageId ?? null` on each pushed block in `threadBlocks`. Add `listRunMessageIds` to `queries.ts` selecting `messages.id` where `runId` and `workspaceId` match, ordered by `createdAt` then `id`. In the run page, load it alongside the existing `Promise.all`, and build each `StoredMessage` with `messageId: ids.length === rendered.length ? (ids[i] ?? null) : null` where `rendered` is the user/assistant subsequence fed to `threadBlocks`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/thread-blocks-message-id.test.ts tests/unit/chat-surface-citations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/agents/queries.ts src/domains/agents/stream-contract.ts "src/app/(workspace)/polymath/[runId]/page.tsx" tests/unit/thread-blocks-message-id.test.ts
git commit -m "feat(agent): pair rendered chat blocks to their stored message ids"
```

---

## Task 9: Message comment server actions and panel (PR B)

**Files:**
- Create: `src/app/(workspace)/polymath/[runId]/comment-actions.ts`
- Create: `src/components/chat/message-comments.tsx`
- Test: `tests/unit/message-comments-panel.test.tsx` (create)

**Interfaces:**
- Consumes: the domain from Task 7; `Result<T>` and `guarded` shape from `src/app/(workspace)/polymath/notes/actions.ts`.
- Produces:
  - `addMessageCommentAction(input: { messageId: string; body: string; idempotencyKey: string }): Promise<Result<{ comment: PanelComment }>>`
  - `resolveMessageCommentAction(input: { commentId: string; resolved: boolean; idempotencyKey: string }): Promise<Result<{ resolvedAt: string | null }>>`
  - `type PanelComment = { id: string; body: string; resolvedAt: string | null; createdAt: string; authorName: string | null }`
  - `MessageComments({ messageId, initialComments }: { messageId: string; initialComments: PanelComment[] })`

- [ ] **Step 1: Write the failing test**

```tsx
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MessageComments } from "@/components/chat/message-comments";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(workspace)/polymath/[runId]/comment-actions", () => ({
  addMessageCommentAction: vi.fn(),
  resolveMessageCommentAction: vi.fn(),
}));

describe("MessageComments", () => {
  it("renders an existing comment with its author and body", () => {
    const html = renderToStaticMarkup(createElement(MessageComments, {
      messageId: "m1",
      initialComments: [{ id: "c1", body: "Worth keeping.", resolvedAt: null, createdAt: new Date().toISOString(), authorName: "Ashwin" }],
    }));
    expect(html).toContain("Worth keeping.");
    expect(html).toContain("Ashwin");
  });

  it("strikes a resolved comment and offers Reopen", () => {
    const html = renderToStaticMarkup(createElement(MessageComments, {
      messageId: "m1",
      initialComments: [{ id: "c1", body: "Done with this.", resolvedAt: new Date().toISOString(), createdAt: new Date().toISOString(), authorName: null }],
    }));
    expect(html).toContain("Reopen");
    expect(html).toContain("line-through");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/message-comments-panel.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the actions and the panel**

`comment-actions.ts` is `"use server"`, validates with Zod, calls `getAuthContext()` + `requireRole(auth, "member")`, and maps `MessageCommentError` to `{ ok: false, error }` exactly as `notes/actions.ts` does for `NoteCommentError`.

`message-comments.tsx` is `"use client"` and copies `note-comments-panel.tsx`'s structure: a composer textarea, a `pending` flag, a `resolvedOverride` local mirror so `router.refresh()` does not leave a stale row. It renders `null` entries as an "Add a comment" affordance so the toolbar toggle can open it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/message-comments-panel.test.tsx`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(workspace)/polymath/[runId]/comment-actions.ts" src/components/chat/message-comments.tsx tests/unit/message-comments-panel.test.tsx
git commit -m "feat(chat): comment on a single message"
```

---

## Task 10: Save a message as a note or an idea (PR B)

**Files:**
- Create: `src/domains/knowledge/save-message.ts`
- Create: `src/app/(workspace)/polymath/[runId]/message-actions.ts`
- Test: `tests/unit/save-message.test.ts` (create)

**Interfaces:**
- Consumes: `saveAnswerAsNote` (`./save-answer`), `createNoteInTx` (`./notes`), `artifactLinks` (`./schema`), `withReceipt`.
- Produces:
  - `saveMessageAsNote(auth, input: { runId: string; title: string; text: string; citations: DocumentCitation[]; idempotencyKey: string }): Promise<{ id: string }>`
  - `saveMessageAsIdea(auth, input: { runId: string; title: string; text: string; idempotencyKey: string }): Promise<{ id: string }>`
  - Server actions `saveMessageAsNoteAction` / `saveMessageAsIdeaAction` in `message-actions.ts`.

**Acceptance boundary.** Authorship is acceptance: saving a message as an idea is the owner's own act, so it writes the artifact directly and **does not** create a `zettel_proposals` row. Only model extractions go through the proposal queue.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { messageIdeaTitle } from "@/domains/knowledge/save-message";

describe("messageIdeaTitle", () => {
  it("uses the first sentence of the message, capped at 120 characters", () => {
    expect(messageIdeaTitle("Retries are safe only when duplicate effects are controlled. Everything else is hope."))
      .toBe("Retries are safe only when duplicate effects are controlled.");
  });
  it("falls back to a fixed title for a message with no sentence", () => {
    expect(messageIdeaTitle("   ")).toBe("Saved idea");
  });
  it("caps a long first sentence", () => {
    expect(messageIdeaTitle("x".repeat(400))).toHaveLength(120);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/save-message.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `save-message.ts`**

`simp` `messageIdeaTitle(text)`: trim, take up to the first `.`/`!`/`?` that is followed by whitespace or end, slice to 120, fall back to `"Saved idea"` when blank.

`saveMessageAsNote` delegates to `saveAnswerAsNote` (it already writes the note, the run `reference` edge, and per-document `source` edges), passing `title`, `answer: text`, `citations`, `runId`, `idempotencyKey`.

`saveMessageAsIdea` runs one transaction: `withReceipt` → `createNoteInTx(tx, auth, { title, kind: "zettel", plainText: text, content: docFromText(text) })` → insert an `artifactLinks` row with `targetType: "run"`, `targetId: runId`, `linkType: "source"`, `label: "saved from an answer"`, `onConflictDoNothing` on the edge key. After commit, best-effort `embedArtifact` in a try/catch that logs — the same pattern `acceptZettel` uses so a failed embed never blocks the save.

- [ ] **Step 4: Run the unit test, then the actions**

Run: `npx vitest run tests/unit/save-message.test.ts` — PASS.

Write `message-actions.ts` with `"use server"`, Zod-validated inputs, and `requireRole(auth, "member")`. Both actions call `revalidatePath(`/polymath/${runId}`)`.

- [ ] **Step 5: Prove the two integration invariants**

Create `tests/integration/save-message.test.ts`:

```ts
it("returns the first note for a replayed receipt key", async () => {
  const a = await saveMessageAsNote(auth, { runId, title: "T", text: "Answer", citations: [], idempotencyKey: "k1" });
  const b = await saveMessageAsNote(auth, { runId, title: "T", text: "Answer", citations: [], idempotencyKey: "k1" });
  expect(b.id).toBe(a.id);
  expect(await noteCount("T")).toBe(1);
});

it("returns the first idea for a replayed receipt key", async () => {
  const a = await saveMessageAsIdea(auth, { runId, title: "I", text: "Claim", idempotencyKey: "k2" });
  const b = await saveMessageAsIdea(auth, { runId, title: "I", text: "Claim", idempotencyKey: "k2" });
  expect(b.id).toBe(a.id);
});

it("writes a zettel artifact with a source edge to the run", async () => {
  const { id } = await saveMessageAsIdea(auth, { runId, title: "I", text: "Claim", idempotencyKey: "k3" });
  const artifact = await artifactRow(id);
  expect(artifact.kind).toBe("zettel");
  const edges = await linkRows(id);
  expect(edges.some((e) => e.targetType === "run" && e.targetId === runId && e.linkType === "source")).toBe(true);
});
```

Run: `npx vitest run --project db tests/integration/save-message.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add src/domains/knowledge/save-message.ts "src/app/(workspace)/polymath/[runId]/message-actions.ts" tests/unit/save-message.test.ts
git commit -m "feat(chat): save a message as a note or an idea"
```

---

## Task 11: Wire the four actions into the toolbar (PR B)

**Files:**
- Modify: `src/components/chat/message-actions.tsx`
- Modify: `src/components/chat/chat-surface.tsx`
- Test: `tests/unit/message-actions.test.tsx` (extend)

**Interfaces:**
- Consumes: Tasks 9 and 10.
- Produces: `MessageActions` gains the comment toggle, "Save as note", and "Save as idea". "Extract ideas" is added in Task 20 once the pipeline exists.

- [ ] **Step 1: Write the failing tests**

```tsx
it("offers comment, save-as-note and save-as-idea on a finished answer", () => {
  const html = renderToStaticMarkup(createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer", messageId: "m1" }));
  expect(html).toContain('aria-label="Comment"');
  expect(html).toContain("Save as note");
  expect(html).toContain("Save as idea");
});

it("omits the comment control when the block has no stored message", () => {
  const html = renderToStaticMarkup(createElement(MessageActions, { runId: "r1", turnId: "t1", text: "Answer", messageId: null }));
  expect(html).not.toContain('aria-label="Comment"');
  expect(html).toContain("Save as note");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/message-actions.test.tsx`
Expected: FAIL — the controls are absent.

- [ ] **Step 3: Render the controls**

Add three buttons beside copy, matching the existing quiet-muted icon idiom (`size-7`, `text-muted-foreground/70 hover:bg-muted hover:text-foreground`). Comment toggles a `showComments` state that renders `<MessageComments messageId={...} initialComments={[]} />` directly under the toolbar. Save actions call the Task 10 actions with `crypto.randomUUID()` as the key, show `Saving…` while pending, and on failure render the returned `error` on one line under the toolbar — never a silent no-op. In `chat-surface.tsx`, pass `messageId={block.messageId ?? null}` from Task 8.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/message-actions.test.tsx`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/message-actions.tsx src/components/chat/chat-surface.tsx tests/unit/message-actions.test.tsx
git commit -m "feat(chat): comment, save-as-note and save-as-idea on a message"
```

---

## Task 12: Context chips replace silent @-mentions (PR B)

**Files:**
- Create: `src/components/chat/context-chips.tsx`
- Modify: `src/components/chat/mention-context.ts`
- Test: `tests/unit/mention-context.test.ts` (extend)

**Interfaces:**
- Consumes: `MentionEntity`, `serializeMentionContext` (unchanged contracts).
- Produces:
  - `MentionEntity` widens to `RecordReference & { kind: "person" | "company" | "zettel" }`.
  - `type ContextChip = { entity: MentionEntity; context: Record<string, unknown> | null; error: string | null }`
  - `serializeChips(chips: ContextChip[]): string` — the payload for already-fetched chips; skips null contexts and reports truncation.
  - `type SerializeResult = { payload: string; truncated: boolean }`
  - `ContextChips({ chips, onRemove, onRetry }: { chips: ContextChip[]; onRemove: (id: string) => void; onRetry: (id: string) => void })`

**Byte-identical constraint.** With no chips `serializeChips([])` returns `""`, so the outgoing message is exactly the typed text — the same as today. `serializeMentionContext`, `stripMentionContext` and `fitMentionContext` are not modified; `serializeChips` is a thin wrapper that reports whether `serializeMentionContext` dropped anything (it compares the produced block count against the entry count).

- [ ] **Step 1: Write the failing test**

```ts
import { serializeChips } from "@/components/chat/mention-context";

const person = { id: "11111111-1111-4111-8111-111111111111", kind: "person" as const, title: "Ann", href: "/x" };

describe("serializeChips", () => {
  it("returns an empty payload with no chips", () => {
    expect(serializeChips([])).toEqual({ payload: "", truncated: false });
  });
  it("serializes a fetched chip into one mention block", () => {
    const { payload, truncated } = serializeChips([{ entity: person, context: { name: "Ann" }, error: null }]);
    expect(payload).toContain(`[context:mention id=${person.id}]`);
    expect(truncated).toBe(false);
  });
  it("skips a chip whose fetch failed and reports nothing truncated", () => {
    expect(serializeChips([{ entity: person, context: null, error: "Could not load" }]))
      .toEqual({ payload: "", truncated: false });
  });
  it("reports truncation when the budget drops a block", () => {
    const big = { body: "x".repeat(1900) };
    const chips = [0, 1, 2].map((i) => ({ entity: { ...person, id: `1111111${i}-1111-4111-8111-111111111111` }, context: big, error: null }));
    expect(serializeChips(chips).truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mention-context.test.ts`
Expected: FAIL — `serializeChips` is not exported.

- [ ] **Step 3: Implement the contract and the chip row**

In `mention-context.ts`: widen `MentionEntity`'s kind, add `ContextChip`, and implement `serializeChips` over `serializeMentionContext`. Keep `resolveMentionPayload` exported for any other caller but stop using it in the composer (Task 13).

`context-chips.tsx` renders one chip per entity: `KindGlyph`-style icon, title, kind label, a `×` remove button, and — when `error` is set — destructive styling plus a "Retry" button. When `truncated` is true the chip row shows one line: "Some context did not fit and was left out." The row renders nothing when there are no chips.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mention-context.test.ts`
Expected: PASS, all existing tests plus 4 new.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/mention-context.ts src/components/chat/context-chips.tsx tests/unit/mention-context.test.ts
git commit -m "feat(chat): context chips serialize already-fetched context"
```

---

## Task 13: Fetch on pick, send without a network call (PR B)

**Files:**
- Modify: `src/components/chat/chat-surface.tsx`
- Modify: `src/components/chat/composer-plus.tsx`
- Test: `tests/unit/chat-surface-chips.test.tsx` (create)

**Interfaces:**
- Consumes: `ContextChip`, `serializeChips` (Task 12), `fetchMentionContext`.
- Produces: nothing later. The deliverable is that `send()` performs no context fetch and refuses to send while a chip is in error.

- [ ] **Step 1: Write the failing tests**

```tsx
it("sends byte-identical text when no chip is present", () => {
  // Type a message, press send, assert the POST body's message is exactly the typed text.
  expect(postedMessage).toBe("What did we decide about retries?");
});
it("appends the chip's block and nothing else when a chip is present", () => {
  expect(postedMessage).toContain("What did we decide about retries?");
  expect(postedMessage).toMatch(/\n\[context:mention id=[^\]]+\]\n\{.*\}$/);
});
it("blocks the send while a chip's fetch failed", () => {
  // The send button is disabled and the message text is still in the composer.
  expect(sendDisabled).toBe(true);
  expect(draft).toBe("What did we decide about retries?");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/chat-surface-chips.test.tsx`
Expected: FAIL — no chips exist yet.

- [ ] **Step 3: Rework the composer's mention state**

Replace the `mentions` array with `chips: ContextChip[]`. On pick: append `{ entity, context: null, error: null }` **without touching `draft`**, then `await fetchMentionContext({ kind, id })` and set `context` on success or `error` on failure/null. `send()` becomes `const { payload } = serializeChips(chips); await onContinue(runId, \`${message}${payload}\`)` — no `await` on a fetch. The send button is disabled when `draft.trim() === ""`, `sending`, **or** `chips.some((c) => c.error !== null || c.context === null)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/chat-surface-chips.test.tsx tests/unit/chat-surface-citations.test.ts`
Expected: PASS. If the static-markup harness cannot drive `onChange`/submit, build the assertions with `@testing-library/react`'s `fireEvent` under the `ui` project instead, keeping the same three assertions.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/chat-surface.tsx src/components/chat/composer-plus.tsx tests/unit/chat-surface-chips.test.tsx
git commit -m "feat(chat): context chips fetch on pick and send without a network call"
```

---

## Task 14: One picker, and the idea payload (PR B)

**Files:**
- Modify: `src/components/chat/composer-plus.tsx`
- Modify: `src/app/(workspace)/polymath/mention-actions.ts`
- Test: `tests/unit/idea-context-payload.test.ts` (create)

**Interfaces:**
- Produces:
  - `ideaContextPayload(idea: { title: string; claim: string; tags: string[]; links: Array<{ title: string; relation: string }> }): Record<string, unknown>` — exactly `{ title, claim, tags, links }`, `claim` cut to 600 characters, `links` at most five.
  - `fetchMentionContext` accepts `kind: "zettel"` and returns that payload.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ideaContextPayload } from "@/app/(workspace)/polymath/mention-actions";

const idea = {
  title: "The cache is the bill",
  claim: "y".repeat(900),
  tags: ["#llms"],
  links: Array.from({ length: 8 }, (_, i) => ({ title: `Idea ${i}`, relation: "extends" })),
};

describe("ideaContextPayload", () => {
  it("carries title, claim, tags and at most five links", () => {
    const payload = ideaContextPayload(idea);
    expect(payload.title).toBe("The cache is the bill");
    expect(payload.tags).toEqual(["#llms"]);
    expect((payload.links as unknown[]).length).toBe(5);
  });
  it("cuts the claim to 600 characters", () => {
    expect((ideaContextPayload(idea).claim as string).length).toBe(600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/idea-context-payload.test.ts`
Expected: FAIL — module or export missing. Note that `mention-actions.ts` is `"use server"`; export `ideaContextPayload` from a sibling non-server module, `src/app/(workspace)/polymath/idea-context.ts`, and re-export it if the action needs it. Import the test from `idea-context.ts`.

- [ ] **Step 3: Implement the payload and collapse the pickers**

`idea-context.ts` implements `ideaContextPayload` as a pure function. In `mention-actions.ts`, extend the Zod enum to `["person", "company", "zettel"]` and add a `zettel` branch: read the artifact's `currentVersionId` `plainText` (claim), its `tags`, and up to five `artifactLinks` rows with `linkType` in `RELATION_TYPES`, mapping each to `{ title: label, relation: RELATION_LABELS[linkType] }`; return `ideaContextPayload(...)`.

In `composer-plus.tsx`, delete the divergent `@` result list: a bare `@` opens the same plus menu with `initialQuery` seeded from the token, so both gestures share one fetch effect and one set of results. Picking a `zettel` record adds a chip instead of inserting markdown; picking a person, company, document or note keeps inserting its reference link.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/idea-context-payload.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/composer-plus.tsx "src/app/(workspace)/polymath/mention-actions.ts" "src/app/(workspace)/polymath/idea-context.ts" tests/unit/idea-context-payload.test.ts
git commit -m "feat(chat): one picker and an idea chip that carries its own claim"
```

---

## Task 15: Source-agnostic `proposeZettels` (PR C)

**Files:**
- Modify: `src/domains/knowledge/zettels.ts`
- Test: `tests/unit/zettel-dedupe-key.test.ts` (create), `tests/integration/zettel-artifact-source.test.ts` (create)

**Interfaces:**
- Consumes: `zettelProposals.sourceArtifactId` (Task 6), `artifacts.currentVersionId` → `artifactVersions.plainText`.
- Produces:
  - `zettelDedupeKey(prefix: "doc" | "artifact", sourceId: string, spanStart: number, spanEnd: number): string` returning `zettel:doc:<id>:<start>-<end>` or `zettel:artifact:<id>:<start>-<end>`.
  - `type ProposalRow = typeof zettelProposals.$inferSelect`
  - `proposeZettels(auth, input: { documentId: string; extractor?: ZettelExtractor; tx?: TxDrizzle } | { sourceArtifactId: string; extractor?: ZettelExtractor; tx?: TxDrizzle }): Promise<ProposalRow[]>` — Task 18 widens the return type to `ZettelProposalResult`; until then this is the shape.
  - `resolveZettelSource(auth, input, conn): Promise<{ text: string; documentId: string | null; extractionId: string | null; sourceArtifactId: string | null; title: string }>` — Task 18's pipeline calls this directly instead of re-reading the source.

**No backfill.** Existing rows keep `zettel:<documentId>:<start>-<end>`. The new function only writes the prefixed form, so old and new rows coexist without a rewrite.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { zettelDedupeKey } from "@/domains/knowledge/zettels";

describe("zettelDedupeKey", () => {
  it("names the document path", () => {
    expect(zettelDedupeKey("doc", "d1", 0, 20)).toBe("zettel:doc:d1:0-20");
  });
  it("names the artifact path", () => {
    expect(zettelDedupeKey("artifact", "a1", 40, 90)).toBe("zettel:artifact:a1:40-90");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/zettel-dedupe-key.test.ts`
Expected: FAIL — the signature does not match.

- [ ] **Step 3: Split the source resolution**

Extract the source text lookup into `resolveZettelSource(auth, input, conn): Promise<{ text: string; documentId: string | null; extractionId: string | null; sourceArtifactId: string | null; title: string }>`. The document branch is today's succeeded-extraction query, unchanged. The artifact branch reads the artifact by id and workspace, joins `artifactVersions` on `currentVersionId`, and returns `plainText`; a missing or blank body throws `"artifact has no readable text"`.

`proposeZettels` then runs the existing validate-and-locate loop over the resolved text, and inserts with `documentId`/`extractionId` or `sourceArtifactId` set, `dedupeKey: zettelDedupeKey("doc" | "artifact", ...)`, and `onConflictDoNothing` on the matching unique index.

Update the two call sites that rely on the old key: `acceptZettel`'s edge label and `listZettelProposals`, which must now filter on whichever source column is set rather than always `documentId`.

- [ ] **Step 4: Run the unit test, then the integration test**

Run: `npx vitest run tests/unit/zettel-dedupe-key.test.ts` — PASS.

Create `tests/integration/zettel-artifact-source.test.ts` proving: an artifact-sourced run writes rows with `source_artifact_id` and a null `document_id`; a quote absent from the artifact's body is dropped; accepting one still creates the zettel artifact and its `source` edge (the edge now points at the artifact, not a document).

Run: `npx vitest run --project db tests/integration/zettel-artifact-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/zettels.ts tests/unit/zettel-dedupe-key.test.ts tests/integration/zettel-artifact-source.test.ts
git commit -m "feat(zettels): propose from a document or an artifact through one seam"
```

---

## Task 16: Heading-split chunking with overflow accounting (PR C)

**Files:**
- Create: `src/domains/knowledge/zettel-chunking.ts`
- Test: `tests/unit/zettel-chunking.test.ts` (create)

**Interfaces:**
- Produces:
  - `const ZETTEL_SECTION_MAX_CHARS = 12_000`
  - `const ZETTEL_MAX_SECTIONS = 12`
  - `type ZettelSection = { text: string; start: number; end: number }`
  - `splitSections(text: string): { sections: ZettelSection[]; readChars: number; unreadChars: number; unreadSections: number }`
  - `const ZETTEL_MERGE_MAX_PER_SOURCE = 20`

`start`/`end` are offsets into the **source text**, so a quote located inside a section can be mapped back to source coordinates and stored in `span_start`/`span_end` unchanged in meaning.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ZETTEL_MAX_SECTIONS, ZETTEL_SECTION_MAX_CHARS, splitSections } from "@/domains/knowledge/zettel-chunking";

// ~3,300 characters per section, so twelve of them comfortably clear 30,000.
const heading = (n: number) => `## Section ${n}\n\n${"Body text. ".repeat(300)}\n`;

describe("splitSections", () => {
  it("reads a 30,000-character document in full with no section over the cap", () => {
    const text = Array.from({ length: 12 }, (_, i) => heading(i)).join("\n");
    expect(text.length).toBeGreaterThanOrEqual(30_000);
    const { sections, readChars, unreadChars } = splitSections(text);
    expect(unreadChars).toBe(0);
    expect(readChars).toBe(text.length);
    expect(Math.max(...sections.map((s) => s.text.length))).toBeLessThanOrEqual(ZETTEL_SECTION_MAX_CHARS);
  });

  it("reports unread characters instead of silently dropping sections", () => {
    const text = Array.from({ length: ZETTEL_MAX_SECTIONS + 4 }, (_, i) => heading(i)).join("\n");
    const { sections, readChars, unreadChars, unreadSections } = splitSections(text);
    expect(sections.length).toBe(ZETTEL_MAX_SECTIONS);
    expect(unreadChars).toBeGreaterThan(0);
    expect(unreadSections).toBe(4);
    // Every character is either read or explicitly reported; none vanishes.
    expect(readChars + unreadChars).toBe(text.length);
  });

  it("splits an unheaded document on paragraph boundaries", () => {
    const text = Array.from({ length: 40 }, () => "Paragraph body sentence.".repeat(60)).join("\n\n");
    const { sections } = splitSections(text);
    expect(sections.length).toBeGreaterThan(1);
    expect(Math.max(...sections.map((s) => s.text.length))).toBeLessThanOrEqual(ZETTEL_SECTION_MAX_CHARS);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/zettel-chunking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `splitSections`**

Split on `/^#{1,6} .+$/m` boundaries, keeping each heading with its body. Any section still over `ZETTEL_SECTION_MAX_CHARS` is further split at the last paragraph break (`\n\n`) before the cap, falling back to a hard cut at the cap when no break exists. Take at most `ZETTEL_MAX_SECTIONS` sections; sum the remainder into `unreadChars` and count them into `unreadSections`. Offsets are computed from a running cursor over the original string so `start`/`end` stay source coordinates.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/zettel-chunking.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/zettel-chunking.ts tests/unit/zettel-chunking.test.ts
git commit -m "feat(zettels): split a long source into bounded sections"
```

---

## Task 17: The bounded merge pass (PR C)

**Files:**
- Create: `src/domains/knowledge/zettel-merge.ts`
- Test: `tests/unit/zettel-merge.test.ts` (create)

**Interfaces:**
- Consumes: `ZettelCandidate` (`@/integrations/zettels/extractor`), `GenerationProvider` (`@/integrations/generation/provider`).
- Produces:
  - `type SectionCandidate = ZettelCandidate & { start: number; end: number; sectionIndex: number }`
  - `mergeCandidates(candidates: SectionCandidate[], options: { provider: GenerationProvider; max?: number }): Promise<SectionCandidate[]>`

**The invariant.** The merge sees only titles and claims — never quotes — and returns **indices** into the input array, so it cannot invent a candidate or rewrite a quote. Every returned item is one of the input objects, by reference.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { mergeCandidates } from "@/domains/knowledge/zettel-merge";

const c = (title: string, claim: string, start: number) => ({ title, claim, quote: `q-${title}`, start, end: start + 10, sectionIndex: 0 });
const provider = (keep: number[]) => ({ name: "test", generate: vi.fn(async () => ({ text: JSON.stringify({ keep }), usage: null })) });

describe("mergeCandidates", () => {
  it("returns the input objects the model keeps, quotes untouched", async () => {
    const input = [c("A", "one", 0), c("B", "two", 20), c("C", "three", 40)];
    const out = await mergeCandidates(input, { provider: provider([0, 2]) as never });
    expect(out.map((x) => x.quote)).toEqual(["q-A", "q-C"]);
    expect(out[0]).toBe(input[0]);
  });
  it("cannot introduce a candidate the extractors did not produce", async () => {
    const input = [c("A", "one", 0)];
    const out = await mergeCandidates(input, { provider: provider([0, 7, 99]) as never });
    expect(out).toHaveLength(1);
  });
  it("caps the survivors at the source maximum", async () => {
    const input = Array.from({ length: 30 }, (_, i) => c(`I${i}`, `claim ${i}`, i * 10));
    const out = await mergeCandidates(input, { provider: provider(input.map((_, i) => i)) as never, max: 20 });
    expect(out).toHaveLength(20);
  });
  it("sends only titles and claims, never the quote text", async () => {
    const spy = provider([0]);
    await mergeCandidates([c("A", "one", 0)], { provider: spy as never });
    expect(JSON.stringify(spy.generate.mock.calls)).not.toContain("q-A");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/zettel-merge.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mergeCandidates`**

Build a numbered list of `{ index, title, claim }`, call `provider.generate` with `json: true` and a system prompt that asks for `{"keep":[<indices>]}` in strongest-first order, drops near-duplicates and ranks. Guard the reply with a Zod schema, filter indices to `0 <= i < input.length`, dedupe, slice to `max ?? ZETTEL_MERGE_MAX_PER_SOURCE`, and map back to input references. An unreadable reply throws `"The merge step returned an unreadable answer."` — never a silent empty result.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/zettel-merge.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/zettel-merge.ts tests/unit/zettel-merge.test.ts
git commit -m "feat(zettels): merge section candidates without touching their evidence"
```

---

## Task 18: Drive the pipeline and report what was read (PR C)

**Files:**
- Modify: `src/domains/knowledge/zettels.ts`
- Modify: `src/domains/capture/zettel-generation.ts`
- Test: `tests/integration/zettel-pipeline.test.ts` (create)

**Interfaces:**
- Consumes: `splitSections` (Task 16), `mergeCandidates` (Task 17), `resolveZettelSource` (Task 15).
- Produces:
  - `type ZettelProposalResult = { proposals: ProposalRow[]; readChars: number; unreadChars: number; unreadSections: number }`
  - `proposeZettels` returns `ZettelProposalResult` (callers that only need the rows read `.proposals`).
  - `runZettelGenerationRequested` returns `{ proposed: number; unreadChars: number }`.

**Both callers change with this.** `proposeZettelsAction` in `src/app/(workspace)/polymath/knowledge/actions.ts` currently does `const created = await proposeZettels(...)` then `created.length` and must become `const { proposals } = await proposeZettels(...)` then `proposals.length`; `runZettelGenerationRequested` in `zettel-generation.ts` currently does `proposeZettels(...)` into `created: Array<{ id: string }>` and reads `created.length`, so it must destructure `{ proposals }` and read `proposals.length`. Grep for `proposeZettels(` and update every call site in this task — a missed one is a type error the typecheck step catches, but only after the whole pipeline lands.

**The behaviour this replaces.** `MAX_ZETTELS_PER_DOCUMENT = 8` is deleted; `ZETTEL_MERGE_MAX_PER_SOURCE = 20` replaces it, because a merged pass over bounded sections can legitimately produce more than one call's worth. The extractor's own `MAX_INPUT_CHARS` slice stays — a section is already under it, so it never truncates a section.

- [ ] **Step 1: Write the failing test**

```ts
it("reads every section of a 30,000-character document", async () => {
  // A fake extractor that records the text it was handed, one call per section.
  const seen: string[] = [];
  const extractor = { name: "fake", extract: async (text: string) => { seen.push(text); return [] as never[]; } };
  await proposeZettels(auth, { documentId, extractor });
  expect(seen.length).toBeGreaterThan(1);
  expect(seen.join("")).not.toContain("…");           // nothing sliced by the extractor's cap
  expect(seen.reduce((n, t) => n + t.length, 0)).toBeGreaterThanOrEqual(12_000 * seen.length - 1);
});

it("reports unread characters for a source over the section cap", async () => {
  const result = await proposeZettels(auth, { documentId: hugeDocumentId, extractor: fakeExtractor });
  expect(result.unreadChars).toBeGreaterThan(0);
  expect(result.unreadSections).toBeGreaterThan(0);
});

it("drops a candidate whose quote is not verbatim in its own section", async () => {
  const extractor = { name: "fake", extract: async () => [
    { title: "Real", claim: "A claim", quote: verbatimPassage },
    { title: "Invented", claim: "A claim", quote: "this sentence is not in the document anywhere at all" },
  ] };
  const { proposals } = await proposeZettels(auth, { documentId, extractor });
  expect(proposals.map((p) => p.title)).toEqual(["Real"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project db tests/integration/zettel-pipeline.test.ts`
Expected: FAIL — the return shape and per-section behaviour do not exist.

- [ ] **Step 3: Wire the pipeline into `proposeZettels`**

Resolve the source text once, `splitSections` it, then for each section: call `extractor.extract(section.text)`, and for each candidate `locate(section.text, quote)`; when found, offset `start`/`end` by `section.start` so the span indexes the **source**, and record the `sectionIndex`. Collect all survivors, run `mergeCandidates` once over them, then insert as today. Return the counts from `splitSections` alongside the created rows.

In `zettel-generation.ts`, the existing "this document already has proposals" short-circuit stays; extend the audit metadata with `readChars` and `unreadChars` so the number is inspectable, and return `unreadChars` from the handler.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project db tests/integration/zettel-pipeline.test.ts && npx vitest run tests/unit/zettel-extractor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/zettels.ts src/domains/capture/zettel-generation.ts tests/integration/zettel-pipeline.test.ts
git commit -m "feat(zettels): chunk, merge, and report what was not read"
```

---

## Task 19: Corpus-aware dedup at proposal time (PR C)

**Files:**
- Modify: `src/domains/knowledge/zettels.ts`
- Modify: `src/app/(workspace)/polymath/knowledge/page.tsx`
- Test: `tests/unit/zettel-duplicate-threshold.test.ts` (create), `tests/integration/zettel-dedup.test.ts` (create)

**Interfaces:**
- Consumes: `embeddingProvider` (`@/integrations/embeddings/provider`), `embeddings` rows with `ownerType = 'artifact'`, `duplicateOfArtifactId` (Task 6).
- Produces:
  - `const ZETTEL_DUPLICATE_MAX_DISTANCE = 0.15`
  - `findDuplicateIdea(auth, claim: string, options?: { provider?: EmbeddingProvider; excludeArtifactId?: string }): Promise<{ artifactId: string; title: string; distance: number } | null>`
  - `duplicateOfArtifactId` set on inserted proposals, and a `duplicateOf` join on `listZettelProposals`.

**Flag only.** Nothing merges, nothing rejects. A flagged proposal accepts normally.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { ZETTEL_DUPLICATE_MAX_DISTANCE, isDuplicateDistance } from "@/domains/knowledge/zettels";
import { SEMANTIC_EDGE_MAX_DISTANCE } from "@/domains/knowledge/relations";

describe("ZETTEL_DUPLICATE_MAX_DISTANCE", () => {
  it("is the calibrated 0.15", () => {
    expect(ZETTEL_DUPLICATE_MAX_DISTANCE).toBe(0.15);
  });
  it("is much tighter than the related-neighbour threshold", () => {
    expect(ZETTEL_DUPLICATE_MAX_DISTANCE).toBeLessThan(SEMANTIC_EDGE_MAX_DISTANCE / 2);
  });
  it("calls a tight pair a duplicate and a merely-related pair not one", () => {
    expect(isDuplicateDistance(0.08)).toBe(true);
    expect(isDuplicateDistance(0.30)).toBe(false);
    expect(isDuplicateDistance(0.15)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/zettel-duplicate-threshold.test.ts`
Expected: FAIL — neither export exists.

- [ ] **Step 3: Implement the lookup**

`isDuplicateDistance(d) = d <= ZETTEL_DUPLICATE_MAX_DISTANCE`. `findDuplicateIdea` embeds the claim with the provider (throwing `EmbeddingUnconfiguredError` through, so the caller treats it exactly like a missing extractor key), then runs one SQL query against `embeddings` where `owner_type = 'artifact'` and the owning artifact is `kind = 'zettel'`, `archived_at is null`, not the excluded id, ordered by `<=>` distance ascending with `limit 1` and a `having`/`where` on the threshold. In `proposeZettels`, after the merge and before the insert, call it per survivor, and write `duplicateOfArtifactId` when it returns a hit. Wrap the lookup so an unconfigured provider degrades to "no dedup" rather than failing the pass, and log a line when that happens.

`listZettelProposals` left-joins `artifacts` on `duplicateOfArtifactId` and returns `duplicateOf: { id, title } | null` **and** `unreadChars` / `readChars` — today it selects `()` (every column of `zettel_proposals`), neither of which exists on that table, so the review page has nothing to render when Task 19's Step 5 lands unless this task adds them. Read the counts back from the latest `capture.zettels_proposed` audit row's metadata for the document, defaulting both to `0` when there is no such row.

- [ ] **Step 4: Run the unit test, then the integration test**

Run: `npx vitest run tests/unit/zettel-duplicate-threshold.test.ts` — PASS.

`tests/integration/zettel-dedup.test.ts` seeds two accepted zettel artifacts with hand-written `embeddings` rows (no provider call), then asserts: a candidate vector 0.08 from an existing idea is flagged with that idea's id; one at 0.30 is not; accepting a flagged proposal still creates the artifact.

Run: `npx vitest run --project db tests/integration/zettel-dedup.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the two review-UI lines**

In `knowledge/page.tsx`'s proposal list, add under the claim: when `duplicateOf` is set, a line `Already exists as *<title>*` linking to `/polymath/ideas/<id>`; when `unreadChars > 0`, a line `Read <read> of <total> characters — <unread> in <n> sections were not read.` The page must pass both values down from the review read.

- [ ] **Step 6: Commit**

```bash
git add src/domains/knowledge/zettels.ts "src/app/(workspace)/polymath/knowledge/page.tsx" tests/unit/zettel-duplicate-threshold.test.ts tests/integration/zettel-dedup.test.ts
git commit -m "feat(zettels): flag proposals that duplicate an existing idea"
```

---

## Task 20: Zettelize a thread or a run of messages (PR C)

**Files:**
- Create: `src/domains/knowledge/thread-zettels.ts`
- Create: `src/app/(workspace)/polymath/[runId]/zettel-actions.ts`
- Test: `tests/integration/thread-zettels.test.ts` (create)

**Interfaces:**
- Consumes: `transcriptMarkdown` (`./thread-graph`), `createNoteInTx` (`./notes`), `proposeZettels` (Task 18).
- Produces:
  - `zettelizeThread(auth, input: { threadId: string; messageIds?: string[]; idempotencyKey: string }): Promise<{ artifactId: string; proposed: number; unreadChars: number }>`
  - Server action `zettelizeThreadAction`.

**Why note-kind, not `kind: "transcript"`.** `record-search.ts` files transcript artifacts under "artifact", so a thread-sourced idea's provenance card would read wrongly, and `syncThreadToGraph` already creates a note for a whole thread — the two paths stay consistent, differing only in which messages are in the body.

**Idempotency.** The artifact's `source` edge points at the thread. Re-running over the same `messageIds` reuses that artifact when its `plainText` matches, so no second body is written and `proposeZettels`' dedupe key lands on the same span rows.

- [ ] **Step 1: Write the failing test**

```ts
it("zettelizes only the selected messages' text", async () => {
  const { artifactId } = await zettelizeThread(auth, { threadId, messageIds: [m2] });
  const body = await bodyOf(artifactId);
  expect(body).toContain("only this reply");
  expect(body).not.toContain("the first question");
});

it("producing the same proposals twice over one thread", async () => {
  const first = await zettelizeThread(auth, { threadId, idempotencyKey: "k1" });
  const second = await zettelizeThread(auth, { threadId, idempotencyKey: "k2" });
  expect(second.artifactId).toBe(first.artifactId);
  expect(second.proposed).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project db tests/integration/thread-zettels.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `zettelizeThread`**

One transaction: `withReceipt` → read the thread (workspace-scoped, applying the Supervisor privacy rule from `syncThreadToGraph`) → select the messages, filtered to `messageIds` when given and always ordered by `createdAt, id` → `transcriptMarkdown` → throw `ThreadEmptyError` when blank → find the existing artifact via the thread's `source` edge; update its version only when the text changed, otherwise reuse it → audit. Then, outside the transaction, call `proposeZettels(auth, { sourceArtifactId })` and return its counts. `proposeZettels` dedupes against the artifact's own earlier proposals first, then the corpus (Task 19), so a repeat stacks nothing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project db tests/integration/thread-zettels.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the filter is per-section, not per-document**

In `tests/integration/zettel-pipeline.test.ts`, add the artifact-path half of the spec's verbatim-quote rule. A quote that is verbatim somewhere in the artifact but **not** in the section that produced it must be dropped: evidence is per-section, so a candidate cannot reach across the document for a supporting passage its own section never contained.

```ts
it("drops a candidate whose quote is verbatim elsewhere but not in its own section", async () => {
  const extractor = { name: "fake", extract: async (text: string) =>
    text.includes("Section 1") ? [{ title: "Reach", claim: "A claim", quote: sectionTwoPassage }] : [] };
  const { proposals } = await proposeZettels(auth, { sourceArtifactId: artifactWithTwoSections, extractor });
  expect(proposals).toEqual([]);
});
```

Run: `npx vitest run --project db tests/integration/zettel-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 6: Add "Extract ideas" to the toolbar**

In `message-actions.tsx`, add the fourth control, which opens a small panel offering "This message", "The last 5 messages", or "The whole conversation", and calls `zettelizeThreadAction` with the corresponding ids. It reports `proposed` and, when non-zero, `unreadChars`.

- [ ] **Step 7: Commit**

```bash
git add src/domains/knowledge/thread-zettels.ts "src/app/(workspace)/polymath/[runId]/zettel-actions.ts" src/components/chat/message-actions.tsx tests/integration/thread-zettels.test.ts
git commit -m "feat(chat): zettelize a thread or a run of messages"
```

---

## Task 21: Topic hubs (PR D)

**Files:**
- Create: `src/domains/knowledge/topic-hubs.ts`
- Modify: `src/domains/knowledge/relations.ts` (`nearestNeighbors` excludes hubs)
- Test: `tests/integration/topic-hubs.test.ts` (create)

**Interfaces:**
- Consumes: `SEED_TAXONOMY` L1 entries (`./taxonomy`), `artifacts`, `artifactLinks`.
- Produces:
  - `ensureTopicHub(auth, slug: string): Promise<{ id: string; title: string }>`
  - `fileIdeaUnderTopic(auth, input: { artifactId: string; topicSlug: string }): Promise<void>` — writes the `part_of` edge to the hub.

**Why hubs are `kind: "other"`.** The Ideas surface reads `kind in ('note','zettel')`, so a hub never appears as an idea; the semantic pass's neighbour query lists kinds explicitly, so a hub is never suggested as a related idea and never receives a `semantic` edge.

- [ ] **Step 1: Write the failing test**

```ts
it("creates one hub per topic under concurrent first use", async () => {
  const [a, b] = await Promise.all([ensureTopicHub(auth, "coding-development"), ensureTopicHub(auth, "coding-development")]);
  expect(a.id).toBe(b.id);
  expect(await hubCount("coding-development")).toBe(1);
});

it("never appears in the Ideas list", async () => {
  await ensureTopicHub(auth, "coding-development");
  const { items } = await pageZettelCards(auth, { limit: 50, offset: 0 });
  expect(items.some((i) => i.title === "Coding & Development")).toBe(false);
});

it("files an idea under two topics with two part_of edges", async () => {
  await fileIdeaUnderTopic(auth, { artifactId, topicSlug: "coding-development" });
  await fileIdeaUnderTopic(auth, { artifactId, topicSlug: "research-learning" });
  expect(await partOfEdges(artifactId)).toHaveLength(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project db tests/integration/topic-hubs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement hub creation and filing**

`ensureTopicHub` resolves the L1 display name from `SEED_TAXONOMY` (throw for an unknown or non-L1 slug — never invent a label), then inserts an artifact with `kind: "other"`, `status: "reviewed"`, `title` = display name, plus a version whose `plainText` names the topic. Serialize concurrent creation with `pg_advisory_xact_lock(hashtextextended('topic-hub:' || slug, 0))` inside a transaction and re-check after the lock, so two callers converge on one row. `fileIdeaUnderTopic` ensures the hub, then inserts an `artifactLinks` row with `linkType: "part_of"`, `targetType: "note"`, `label` = hub title, `onConflictDoNothing` on the edge key.

`nearestNeighbors` already lists its kinds explicitly and omits `other`, so a hub is never a neighbour. Close the other direction too: `materializeSemanticEdges` must return `0` without querying when the artifact's `kind === 'other'`, so a hub never writes `semantic` out-edges even if something calls it with a hub id.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project db tests/integration/topic-hubs.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/topic-hubs.ts src/domains/knowledge/relations.ts tests/integration/topic-hubs.test.ts
git commit -m "feat(graph): topic hubs give ideas bounded multi-topic reach"
```

---

## Task 22: Link rationale on demand (PR D)

**Files:**
- Create: `src/domains/knowledge/link-rationale.ts`
- Create: `src/app/(workspace)/polymath/graph/rationale-actions.ts`
- Test: `tests/unit/link-rationale-prompt.test.ts` (create), `tests/integration/link-rationale.test.ts` (create)

**Interfaces:**
- Produces:
  - `rationalePrompt(source: { title: string; claim: string }, target: { title: string; claim: string }): { system: string; prompt: string }`
  - `explainLink(auth, input: { linkId: string; provider?: GenerationProvider }): Promise<{ context: string }>` — writes `artifactLinks.context` and returns it. An existing `context` is returned without a model call.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { rationalePrompt } from "@/domains/knowledge/link-rationale";

describe("rationalePrompt", () => {
  const out = rationalePrompt({ title: "Retries improve reliability", claim: "Retries raise success rates." },
                               { title: "Retries need idempotency", claim: "Retries are safe only when effects are deduplicated." });
  it("names both claims and asks for one sentence", () => {
    expect(out.prompt).toContain("Retries raise success rates.");
    expect(out.prompt).toContain("Retries are safe only when effects are deduplicated.");
    expect(out.system).toMatch(/one sentence/i);
  });
  it("carries the untrusted-data clause so the titles are data, not instructions", () => {
    expect(out.system).toContain("<untrusted");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/link-rationale-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the prompt, the write, and the action**

`rationalePrompt` uses `untrustedDataClauseJsonSafe` from `@/lib/prompts` and asks for one sentence justifying the edge named in `linkType`. `explainLink` loads the link plus both artifacts' current `plainText`, returns `context` unchanged when already set, otherwise generates, stores via an `update ... where id = linkId and workspace_id = ...`, and returns it. A generation failure throws a message the action renders; it never writes an empty rationale. The server action validates a `z.string().uuid()` link id and requires member role.

- [ ] **Step 4: Run the unit test, then the integration test**

Run: `npx vitest run tests/unit/link-rationale-prompt.test.ts` — PASS.

`tests/integration/link-rationale.test.ts` asserts: no rationale is written until `explainLink` is called; a second call returns the stored value without invoking the provider again (inject a counting fake).

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/link-rationale.ts "src/app/(workspace)/polymath/graph/rationale-actions.ts" tests/unit/link-rationale-prompt.test.ts tests/integration/link-rationale.test.ts
git commit -m "feat(graph): write a link's rationale when someone opens it"
```

---

## Task 23: Source staleness (PR D)

**Files:**
- Create: `src/domains/knowledge/staleness.ts`
- Modify: `src/domains/knowledge/extraction.ts` (call the marker after a successful new extraction)
- Modify: `src/domains/knowledge/debt.ts`
- Test: `tests/integration/source-staleness.test.ts` (create)

**Interfaces:**
- Produces:
  - `markDerivedIdeasStale(auth, input: { documentId: string; at?: Date }): Promise<number>`
  - `KnowledgeDebt` gains `staleIdeas: KnowledgeDebtSection`

**The namespaced-write rule (§16.8).** The marker merges into `artifacts.metadata` with `jsonb_set`/`||` and sets **only** `metadata`, never `updated_at` — a stale idea must not jump to the top of a list sorted by recency.

- [ ] **Step 1: Write the failing test**

```ts
it("marks derived ideas stale without touching updated_at", async () => {
  const before = await artifactRow(ideaId);
  const marked = await markDerivedIdeasStale(auth, { documentId });
  const after = await artifactRow(ideaId);
  expect(marked).toBe(1);
  expect(after.metadata.sourceChangedAt).toBeDefined();
  expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
});

it("counts stale ideas in the debt report", async () => {
  await markDerivedIdeasStale(auth, { documentId });
  expect((await getKnowledgeDebt(auth)).staleIdeas.total).toBe(1);
});

it("leaves an idea's other metadata keys intact", async () => {
  // metadata written with bloom must survive the merge.
  expect((await artifactRow(ideaId)).metadata.bloom).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project db tests/integration/source-staleness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the marker and the report section**

`markDerivedIdeasStale` writes `coalesce(metadata,'{}'::jsonb) || jsonb_build_object('sourceChangedAt', $at)` on artifacts that have a `source` edge to the document and `kind in ('note','zettel')`, returning the row count. Add it to the extraction success path, after the new extraction commits. In `debt.ts`, add `staleIdeas` as a `LIST_CAP`-bounded section reading `metadata->>'sourceChangedAt' is not null` over live note/zettel artifacts, using the same `section()` helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project db tests/integration/source-staleness.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/knowledge/staleness.ts src/domains/knowledge/extraction.ts src/domains/knowledge/debt.ts tests/integration/source-staleness.test.ts
git commit -m "feat(knowledge): mark ideas stale when their source changes"
```

---

## Task 24: The `zettels_propose` Eve tool (PR D)

**Files:**
- Create: `eve/polymath/agent/tools/zettels_propose.ts`
- Modify: `src/domains/agents/commands.ts` (`DEFAULT_ALLOWED_TOOLS`)
- Modify: `src/domains/agents/authorization.ts` (risk class)
- Test: `tests/unit/zettels-propose-tool.test.ts` (create)

**Interfaces:**
- Consumes: `defineTool`, `toolAllowed`, `getRunBySessionRef`, `proposeZettels`.
- Produces: `zettels.propose` capability; the tool returns `{ ok: true; proposals: Array<{ id: string; duplicateOf: string | null }> }` or `{ ok: false; error: string }`.

**The boundary.** It proposes. It never accepts, never creates an idea artifact, and never claims an idea exists. The description says the proposal waits in the owner's review queue, mirroring `tasks_propose.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import tool from "../../eve/polymath/agent/tools/zettels_propose";

describe("zettels_propose", () => {
  it("tells the model the proposal waits for the owner", () => {
    expect(tool.description).toMatch(/review queue/i);
    expect(tool.description).toMatch(/does not create|nothing is created/i);
  });
  it("requires a stable dedupe id in its input", () => {
    expect(tool.inputSchema.safeParse({ text: "a body", dedupeId: "doc:123" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ text: "a body" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/zettels-propose-tool.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the tool**

Input: `{ text: string (min 1, max 200_000), dedupeId: string (max 200), artifactId?: uuid }`. Execute: resolve `workspaceId` and `principalId` from `ctx.session.auth.current`, load the run via `getRunBySessionRef`, require `run.state === "running"`, require `toolAllowed(run.policySnapshot, "zettels.propose")`, then call `proposeZettels` with `{ sourceArtifactId }` when an artifact id is given (the text is ignored, so the model cannot attribute a quote to a body it invented) or with a transient document path otherwise. Map rows to `{ id, duplicateOf: duplicateOfArtifactId }`.

Register `"zettels.propose"` in `DEFAULT_ALLOWED_TOOLS` with a comment explaining it is a prepare-risk internal write that creates proposals only, and add `"zettels.propose": { capability: "zettel.propose", effectClass: "write" }` to the authorization risk table.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/zettels-propose-tool.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Prove the refusal path**

Add to `tests/unit/zettels-propose-tool.test.ts`:

```ts
it("refuses when the capability is absent from the policy snapshot", () => {
  expect(toolAllowed({ allowedTools: ["tasks.read"] }, "zettels.propose")).toBe(false);
});
```

Run: `npx vitest run tests/unit/zettels-propose-tool.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Commit**

```bash
git add eve/polymath/agent/tools/zettels_propose.ts src/domains/agents/commands.ts src/domains/agents/authorization.ts tests/unit/zettels-propose-tool.test.ts
git commit -m "feat(agent): a zettels_propose tool that only ever proposes"
```

---

## Task 25: Whole-branch verification (all PRs)

**Files:**
- Modify: `docs/superpowers/specs/2026-11-01-chat-actions-context-zettelization-design.md` (status line only)

- [ ] **Step 1: Run the full check**

Run: `pnpm test:ci && pnpm lint && pnpm typecheck`
Expected: all three exit 0. `pnpm test` alone is not sufficient — it skips the db suites locally.

- [ ] **Step 2: Confirm the constraints that a grep can settle**

Run: `grep -rn "neo4j" src docs | grep -v "chat-actions-context-zettelization-design"` — expect no output.
Run: `wc -l src/components/chat/chat-surface.tsx` — expect under 620.

- [ ] **Step 3: Flip the spec's status**

Change `**Status:** approved design, not yet implemented` to `**Status:** implemented`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-11-01-chat-actions-context-zettelization-design.md
git commit -m "docs(spec): mark chat actions and zettelization implemented"
```
