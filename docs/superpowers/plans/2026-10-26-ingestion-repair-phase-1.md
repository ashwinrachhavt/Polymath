# Phase 1 — Make Capture Trustworthy: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a capture an explicit arrival mode, stop a server fetch from overwriting what the person actually captured, make duplicate identity mode-aware, carry URL provenance into the document, make a failed fetch retryable, and stop the browser extension claiming a save it cannot prove.

**Architecture:** One new discriminator column (`captures.capture_mode`) drives which processing is legal, and one new text column (`fetched_text`) keeps the server's reading separate from the person's working text. Dedupe moves from "one row per URL" to two partial unique indexes keyed on mode and a content hash. All five behaviours are edits to existing commands and handlers; no new subsystem and no new table.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM + Neon Postgres, Zod, Vitest (unit + real-Postgres integration), Playwright (headless), MV3 Chrome extension in plain JS.

**Spec:** `docs/superpowers/specs/2026-10-26-ingestion-repair-design.md` — §4 in full, §4.8 for the acceptance list.

## Global Constraints

- `make check` (`pnpm lint && pnpm typecheck && pnpm test && pnpm build`) is the gate. Never `--no-verify`.
- Integration tests need `TEST_DATABASE_URL`. **Never** point it at the app database. When `CI` is set a missing URL throws rather than skipping.
- Migrations are forward-only and never edited after they run. Next free number is `0258` (`0257` is taken by `81ee900` on branch `notebooklm-2`).
- Every owned row carries `workspace_id`; every query is scoped by `AuthContext`. A client never supplies the workspace.
- Every mutation takes an idempotency key recorded in `request_receipts`; audit and outbox rows are written in the same transaction as the change.
- Invariants live in the database (unique, check, not null, partial indexes), not only in application code.
- Stale writes are rejected via `version`, not merged.
- **The em dash is banned in user-visible strings.** Hyphen for ranges and compounds.
- Every automated browser check runs headless. Never open a visible Chrome window.
- `captures.raw_payload` is immutable. Nothing in this plan writes it after insert.
- Commit messages end with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.

## Review Focus

Input classes the spec implies but no task's tests name. Each has a test in the task noted.

1. **`{url}` posted with no `text`** — the API currently stores it as `kind: "text"` with the address as its body. A reasonable person expects an address-only capture. (Task 4)
2. **A selection whose page fetch succeeds** — the whole point of the fix. `text` must still equal the selection afterwards. (Task 5)
3. **A re-capture carrying a different title** — dedupe must not discard it. (Task 3)
4. **An existing `kind: "file"` row after the backfill** — it becomes `capture_mode: "blob"` and must never be fetched or treated as authored text. (Tasks 2, 5, 8)
5. **Jev enabled with a zero allowance** — enrichment must degrade to the deterministic ladder, not dead-letter the event. (Task 8)

---

### Task 1: Capture mode and content hash helpers

Pure functions first, so every later task has a named thing to call.

**Files:**
- Create: `src/domains/capture/mode.ts`
- Test: `tests/unit/capture-mode.test.ts`

**Interfaces:**
- Consumes: `captureMode` (the `pgEnum`, added in Task 2 to `schema.ts`). This task declares the same values locally so it is testable before the schema changes; Task 2 makes `schema.ts` the single source and `mode.ts` re-exports the type.
- Produces:
  - `type CaptureMode = "authored" | "selection" | "page" | "url-reference" | "blob"`
  - `contentHash(text: string): string` — sha256 hex, `node:crypto`, full digest (not truncated: this is a dedupe key, collisions are unacceptable).
  - `inferCaptureMode(input: { text?: string; url?: string; kind?: string }): CaptureMode`
  - `workingText(capture: { captureMode: CaptureMode; text: string | null; fetchedText: string | null }): string | null`

- [ ] **Step 1: Write the failing test**

`tests/unit/capture-mode.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { contentHash, inferCaptureMode, workingText } from "@/domains/capture/mode";

describe("inferCaptureMode", () => {
  it("is url-reference when there is a url and no text", () => {
    expect(inferCaptureMode({ url: "https://example.com/a" })).toBe("url-reference");
  });
  it("is authored when there is text and no url", () => {
    expect(inferCaptureMode({ text: "a thought" })).toBe("authored");
  });
  it("is page when text arrived with a url and no mode was supplied", () => {
    expect(inferCaptureMode({ text: "body", url: "https://example.com/a" })).toBe("page");
  });
  it("is authored when the text is itself a bare address and no url was supplied", () => {
    expect(inferCaptureMode({ text: "https://example.com/a" })).toBe("url-reference");
  });
  it("is blob for a file or a voice capture", () => {
    expect(inferCaptureMode({ kind: "file" })).toBe("blob");
    expect(inferCaptureMode({ kind: "voice" })).toBe("blob");
  });
});

describe("contentHash", () => {
  it("is stable for the same text", () => {
    expect(contentHash("same")).toBe(contentHash("same"));
  });
  it("differs for different text", () => {
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
  it("is 64 hex characters even for a 200k body", () => {
    expect(contentHash("x".repeat(200_000))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("workingText", () => {
  const base = { text: "selection", fetchedText: "whole page" };
  it("keeps the person's text for a selection even after a fetch", () => {
    expect(workingText({ ...base, captureMode: "selection" })).toBe("selection");
  });
  it("prefers the fetched reading for a page grab", () => {
    expect(workingText({ ...base, captureMode: "page" })).toBe("whole page");
  });
  it("falls back to text when a page grab has not been fetched yet", () => {
    expect(workingText({ captureMode: "page", text: "grab", fetchedText: null })).toBe("grab");
  });
  it("prefers the fetched text for a bare address", () => {
    expect(workingText({ captureMode: "url-reference", text: null, fetchedText: "page" })).toBe("page");
  });
  it("is null for a blob with no text", () => {
    expect(workingText({ captureMode: "blob", text: null, fetchedText: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/unit/capture-mode.test.ts`
Expected: FAIL — cannot resolve `@/domains/capture/mode`.

- [ ] **Step 3: Implement `src/domains/capture/mode.ts`**

`inferCaptureMode` order: `kind` of `file`/`voice` → `blob`; bare-address text with no `url` → `url-reference`; `url` with no text → `url-reference`; `url` with text → `page`; otherwise `authored`. Use `/^https?:\/\/\S+$/i` for the bare-address test (the same expression `createCapture` uses today). `workingText`: `page` and `url-reference` prefer `fetchedText`, everything else prefers `text`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/unit/capture-mode.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/capture/mode.ts tests/unit/capture-mode.test.ts
git commit -m "feat(capture): arrival mode and content hash helpers"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `src/domains/capture/schema.ts:21` (add enum), `:55-110` (columns + indexes), `src/domains/capture/mode.ts` (re-export the type from schema)
- Create: `src/db/migrations/0258_capture_mode_and_identity.sql` (generated, then extended by hand), `src/db/migrations/meta/0258_snapshot.json`, `_journal.json` entry
- Test: `tests/integration/capture-identity.test.ts` (first two tests only; the rest come in Task 3)

**Interfaces:**
- Consumes: `contentHash` from Task 1.
- Produces: `captures.captureMode`, `captures.fetchedText`, `captures.contentHash`, `captures.fetchOutcome` columns; enums `captureMode` and `captureFetchOutcome`; indexes `captures_identity_key` and `captures_url_reference_key`. `captures_workspace_source_url_key` no longer exists.

- [ ] **Step 1: Write the failing test**

`tests/integration/capture-identity.test.ts` — follow the `makeTestDb` / `seedWorkspace` / `ownerAuth` pattern in `tests/integration/capture-url-content.test.ts:28-49`:

```ts
it("keeps two different selections from one article", async () => {
  const url = "https://example.com/article";
  await commands.createCapture(auth, { text: "first selection", url, mode: "selection" });
  await commands.createCapture(auth, { text: "second selection", url, mode: "selection" });
  const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
  expect(rows).toHaveLength(2);
});

it("rejects the identical selection twice with the existing id", async () => {
  const url = "https://example.com/article-2";
  const first = await commands.createCapture(auth, { text: "same words", url, mode: "selection" });
  await expect(commands.createCapture(auth, { text: "same words", url, mode: "selection" }))
    .rejects.toMatchObject({ code: "conflict", existingId: first.id });
  const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
  expect(rows).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts`
Expected: FAIL — `mode` is not a known input, and `existingId` is absent.

- [ ] **Step 3: Change `schema.ts`**

Add next to `captureKind`:

```ts
export const captureMode = pgEnum("capture_mode", ["authored", "selection", "page", "url-reference", "blob"]);
export const captureFetchOutcome = pgEnum("capture_fetch_outcome", [
  "pending", "acquired", "error-page", "access-denied", "empty", "provider-unavailable",
]);
```

In the `captures` table, after `url`:

- `captureMode: captureMode("capture_mode").notNull()` — no default; the command always supplies it and the backfill fills history.
- `fetchedText: text("fetched_text")` — the server's reading, separate from `text`.
- `contentHash: text("content_hash")` — sha256 of the arriving text; null for `blob` and `url-reference`.
- `fetchOutcome: captureFetchOutcome("fetch_outcome")` — null until a fetch is attempted.

Replace the single `uniqueIndex("captures_workspace_source_url_key")` with:

```ts
uniqueIndex("captures_identity_key")
  .on(t.workspaceId, t.source, t.url, t.captureMode, t.contentHash)
  .where(sql`url is not null and capture_mode <> 'url-reference'`),
uniqueIndex("captures_url_reference_key")
  .on(t.workspaceId, t.source, t.url)
  .where(sql`url is not null and capture_mode = 'url-reference'`),
```

- [ ] **Step 4: Generate and extend the migration**

Run: `pnpm db:generate` — this writes `src/db/migrations/0258_*.sql`, `meta/0258_snapshot.json`, and the `_journal.json` entry. Do not hand-write those three. Then **append** the backfill and index swap to the generated SQL, in this order (the addition of `capture_mode` must happen before `not null` is enforced, and existing duplicate rows must be neutralised before the unique index is created):

```sql
update captures set capture_mode = case
  when kind = 'url' then 'url-reference'::capture_mode
  when kind = 'text' and url is not null then 'page'::capture_mode
  when kind = 'text' then 'authored'::capture_mode
  else 'blob'::capture_mode end
 where capture_mode is null;

update captures
   set content_hash = encode(sha256(convert_to(coalesce(clean_text, text), 'UTF8')), 'hex')
 where url is not null and capture_mode <> 'url-reference'
   and coalesce(clean_text, text) is not null;

-- Existing rows may already collide under the new rule. Keep the earliest and
-- null the rest, so the unique index can be created; a null hash does not dedupe.
update captures c set content_hash = null
 where c.content_hash is not null and exists (
   select 1 from captures d
    where d.workspace_id = c.workspace_id and d.source = c.source
      and d.url = c.url and d.capture_mode = c.capture_mode
      and d.content_hash = c.content_hash
      and (d.created_at, d.id) < (c.created_at, c.id));

alter table captures alter column capture_mode set not null;
```

If `db:generate` emitted the two new indexes and the index drop already, leave those statements where they are and only append the four backfill statements above **before** the `set not null` and before the `create unique index` lines. Reorder as needed; the constraint is that ordering, not the file layout.

- [ ] **Step 5: Verify the migration metadata still agrees with the schema**

Hand-editing generated SQL after `db:generate` is safe only while the snapshot still
describes the schema. Confirm it does:

```bash
pnpm check:migrations
pnpm db:generate   # must report no changes; if it writes a 0259, the snapshot drifted
```

Expected: `check:migrations` clean, and `db:generate` produces nothing. If it
produces a second migration, delete it and fix `schema.ts` to match what the SQL
actually created, then regenerate — the snapshot is derived from `schema.ts`, so a
drift means one of them is wrong.

- [ ] **Step 6: Apply to the test database, then run the test**

```bash
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts
```

Expected: still FAIL — the command does not yet accept `mode`. That is correct at this point; the schema half is proven by the migration applying cleanly.

- [ ] **Step 7: Commit**

```bash
git add src/domains/capture/schema.ts src/domains/capture/mode.ts src/db/migrations
git commit -m "feat(capture): capture_mode, fetched_text, and mode-aware identity indexes"
```

---

### Task 3: `createCapture` takes a mode, hashes, and keeps late metadata

**Files:**
- Modify: `src/domains/capture/commands.ts:70-160` (`createCapture`), `:36-45` (`ConflictError`, add `updated` flag)
- Modify: `src/domains/capture/queries.ts:19-30` (`findCaptureIdByUrl` → `findCaptureByUrl`)
- Test: `tests/integration/capture-identity.test.ts` (extend)

**Interfaces:**
- Consumes: `inferCaptureMode`, `contentHash` (Task 1); the columns and indexes (Task 2).
- Produces:
  - `createCapture(auth, input: { text: string; url?: string; title?: string; mode?: CaptureMode; source?: CaptureSource; idempotencyKey?: string })`
  - `findCaptureByUrl(auth, input: { source: CaptureSource; url: string; mode: CaptureMode; contentHash: string | null }): Promise<string | undefined>`
  - `ConflictError.existingId` is still the additive member the companion reads; `ConflictError` gains nothing else.

**Why `onConflictDoNothing` and not a caught `23505`:** a unique violation aborts the Postgres transaction, so the follow-up `update` that carries the second submission's title could not run inside it. `insert ... onConflictDoNothing().returning()` leaves the transaction usable, so the survivor's title is updated in the same transaction, before the `ConflictError` is thrown after commit.

- [ ] **Step 1: Write the failing test**

Extend `tests/integration/capture-identity.test.ts`:

```ts
it("writes the supplied title onto the capture", async () => {
  const created = await commands.createCapture(auth, { text: "titled", title: "A real title" });
  expect(created.title).toBe("A real title");
});

it("keeps the second submission's title when the text dedupes", async () => {
  const url = "https://example.com/article-3";
  const first = await commands.createCapture(auth, { text: "shared body", url, mode: "selection", title: "First" });
  await expect(
    commands.createCapture(auth, { text: "shared body", url, mode: "selection", title: "Second" }),
  ).rejects.toMatchObject({ existingId: first.id });
  const [survivor] = await db.select().from(captures).where(eq(captures.id, first.id));
  expect(survivor.title).toBe("Second");
});

it("records a page capture again when the page changed", async () => {
  const url = "https://example.com/changing";
  await commands.createCapture(auth, { text: "version one", url, mode: "page" });
  await commands.createCapture(auth, { text: "version two", url, mode: "page" });
  const rows = await db.select().from(captures).where(eq(captures.workspaceId, workspaceId));
  expect(rows.filter((r) => r.url === url)).toHaveLength(2);
});

it("still rejects a bare address twice", async () => {
  const url = "https://example.com/once";
  await commands.createCapture(auth, { text: url });
  await expect(commands.createCapture(auth, { text: url }))
    .rejects.toMatchObject({ code: "conflict" });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts`
Expected: FAIL on the title tests and the page-refresh test.

- [ ] **Step 3: Implement**

In `createCapture`:

1. Resolve the mode: `const mode = input.mode ?? inferCaptureMode({ text: trimmed, url: input.url, kind: undefined })`.
2. Keep the existing bare-address detection but derive `kind` from the mode: `url-reference` with no supplied `url` → `kind: "url"`, `text: null`. `url-reference` with a supplied `url` → `kind: "url"` as well, which fixes Review Focus 1.
3. Compute `const hash = mode === "blob" || mode === "url-reference" ? null : contentHash(trimmed)`.
4. Set `title: input.title?.trim() || null` on the insert (this is the first of the two small inconsistencies the spec's §8 carries).
5. Replace the bare `insert` with `.onConflictDoNothing().returning()`. When the returning array is empty, look the survivor up with `findCaptureByUrl(auth, { source, url, mode, contentHash: hash })`, update its `title` and `updatedAt` to the second submission's values inside the same transaction, and remember the id on the transaction's return value.
6. After `withTransaction` resolves, if a survivor id was remembered throw `new ConflictError("That URL is already in the inbox.", survivorId)`. Delete the `isUniqueViolation` catch and the `23505` helper if nothing else uses it.
7. Audit event gains the mode in its summary: `Captured ${capture.kind} (${mode})`.

In `queries.ts`, replace `findCaptureIdByUrl` with `findCaptureByUrl` adding `and` clauses on `captureMode` and, when `contentHash` is non-null, `contentHash`.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts`
Expected: PASS, 6 tests.

Then confirm nothing else broke:

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/captures-route.test.ts tests/integration/capture-inbox.test.ts tests/integration/capture-url-chain.test.ts`
Expected: PASS. If `captures-route.test.ts` asserts on a duplicate message it should be unchanged; the 409 body is byte-exact by contract.

- [ ] **Step 5: Commit**

```bash
git add src/domains/capture/commands.ts src/domains/capture/queries.ts tests/integration/capture-identity.test.ts
git commit -m "feat(capture): mode-aware identity that keeps late metadata"
```

---

### Task 4: Fetch only what may be fetched

**Files:**
- Modify: `src/domains/capture/commands.ts` (the outbox enqueue block, currently `:119-125`)
- Test: `tests/integration/capture-identity.test.ts` (extend)

**Interfaces:**
- Consumes: `mode` resolved in Task 3.
- Produces: the rule every later task relies on — `capture.url_content_requested` is enqueued only for `page` and `url-reference`. A `selection` enqueues nothing.

- [ ] **Step 1: Write the failing test**

```ts
it("does not fetch the page for a selection", async () => {
  const capture = await commands.createCapture(auth, {
    text: "just this paragraph", url: "https://example.com/never-fetched", mode: "selection",
  });
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  expect(events.filter((e) => (e.payload as { captureId?: string }).captureId === capture.id)).toHaveLength(0);
});

it("does fetch for a bare address", async () => {
  const capture = await commands.createCapture(auth, { text: "https://example.com/fetched" });
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  expect(events.filter((e) => (e.payload as { captureId?: string }).captureId === capture.id)).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts`
Expected: FAIL — the selection enqueues a fetch today.

- [ ] **Step 3: Implement**

Guard the enqueue on `capture.url && (mode === "page" || mode === "url-reference")`. Update the comment above it, which currently says the scrape "replaces" the grab — it no longer does. Enrichment stays unconditional.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-identity.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/domains/capture/commands.ts tests/integration/capture-identity.test.ts
git commit -m "fix(capture): never fetch a page for a selection"
```

---

### Task 5: The fetch fills `fetched_text` and reports a real outcome

**Files:**
- Create: `src/domains/capture/fetch-outcome.ts`
- Modify: `src/domains/capture/url-content-handler.ts:62-113`
- Test: `tests/unit/capture-fetch-outcome.test.ts`, `tests/integration/capture-url-content.test.ts` (extend)

**Interfaces:**
- Consumes: `captureMode`, `fetchedText`, `fetchOutcome` (Task 2); `workingText` (Task 1).
- Produces: `classifyFetchOutcome(page: { markdown: string; error?: string; statusCode?: number }): { outcome: "acquired" | "error-page" | "empty"; text: string | null }`, and a handler that writes `fetchedText` + `fetchOutcome` instead of overwriting `text`.

- [ ] **Step 1: Write the failing unit test**

`tests/unit/capture-fetch-outcome.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyFetchOutcome } from "@/domains/capture/fetch-outcome";

describe("classifyFetchOutcome", () => {
  it("is acquired for readable content with no error", () => {
    const r = classifyFetchOutcome({ markdown: "# Page\n\nbody" });
    expect(r.outcome).toBe("acquired");
    expect(r.text).toContain("body");
  });
  it("is error-page for a 404 with a readable body", () => {
    expect(classifyFetchOutcome({ markdown: "Not found", error: "404", statusCode: 404 }).outcome).toBe("error-page");
  });
  it("is error-page when the provider reports an error and no status", () => {
    expect(classifyFetchOutcome({ markdown: "gone", error: "render failed" }).outcome).toBe("error-page");
  });
  it("is empty for no readable text", () => {
    const r = classifyFetchOutcome({ markdown: "   " });
    expect(r.outcome).toBe("empty");
    expect(r.text).toBeNull();
  });
  it("never returns text for error-page or empty", () => {
    expect(classifyFetchOutcome({ markdown: "x", statusCode: 500 }).text).toBeNull();
    expect(classifyFetchOutcome({ markdown: "" }).text).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/capture-fetch-outcome.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/domains/capture/fetch-outcome.ts`**

A pure function. `statusCode` present and not in 200-299, **or** `error` present, → `error-page`. Blank markdown → `empty`. Otherwise `acquired`. Only `acquired` returns `text` (trimmed, `title` prefix preserved, sliced to 200,000 — the same shape `scrapePage` builds today).

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run tests/unit/capture-fetch-outcome.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the failing integration test**

Extend `tests/integration/capture-url-content.test.ts`:

```ts
it("keeps a selection as the working text when its fetch lands", async () => {
  const capture = await commands.createCapture(auth, {
    text: "the paragraph I highlighted", url: "https://example.com/kept", mode: "selection",
  });
  // No fetch is enqueued for a selection, so run it directly the way an
  // operator retry would.
  await retryCaptureUrl(auth, { captureId: capture.id });
  scrape.mockResolvedValue({ markdown: "# Whole page\n\nall the other words" });
  await runHandlerFor(capture.id);
  const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
  expect(after.text).toBe("the paragraph I highlighted");
  expect(after.fetchedText).toContain("all the other words");
  expect(after.fetchOutcome).toBe("acquired");
});

it("records a 404 as error-page and leaves the working text alone", async () => {
  const capture = await commands.createCapture(auth, { text: "https://example.com/missing" });
  scrape.mockResolvedValue({ markdown: "Not found", error: "404", statusCode: 404 });
  await runHandlerFor(capture.id);
  const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
  expect(after.fetchOutcome).toBe("error-page");
  expect(after.fetchedText).toBeNull();
  expect(after.failureReason).toContain("could not be read");
});
```

- [ ] **Step 6: Run the integration test to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-url-content.test.ts`
Expected: FAIL on both; `retryCaptureUrl` does not exist yet (Task 6 adds it, so write the second test to construct the event directly here if that is simpler — the assertion is what matters).

- [ ] **Step 7: Change the handler**

In `url-content-handler.ts`: replace `scrapePage`'s truthiness check with `classifyFetchOutcome`. On `acquired`, `ownedUpdate` writes `fetchedText`, `fetchOutcome: "acquired"`, `failureReason: null`, `processingState: "classifying"`, and — **only for `url-reference`** — `text` (so a bare address still becomes readable text for search and conversion). On `error-page` or `empty`, write `fetchOutcome` and a `failureReason` sentence and change nothing else. Update the file's header comment: it currently states there is no retry command; Task 6 adds one, so that paragraph is rewritten in Task 6.

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/unit/capture-fetch-outcome.test.ts && TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-url-content.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domains/capture/fetch-outcome.ts src/domains/capture/url-content-handler.ts tests/unit/capture-fetch-outcome.test.ts tests/integration/capture-url-content.test.ts
git commit -m "feat(capture): fetch fills fetched_text and reports a real outcome"
```

---

### Task 6: Retry a failed fetch

**Files:**
- Modify: `src/domains/capture/commands.ts` (new `retryCaptureUrl`), `src/domains/capture/url-content-handler.ts` (header comment)
- Modify: `src/app/(workspace)/command-center/inbox/actions.ts` (new server action)
- Test: `tests/integration/url-capture.test.ts` (extend)

**Interfaces:**
- Consumes: `CAPTURE_URL_CONTENT_TOPIC`, `enqueueOutbox`, `recordAudit`, `withReceipt`, `withTransaction` (all already imported in `commands.ts`).
- Produces:
  - `retryCaptureUrl(auth, input: { captureId: string; idempotencyKey?: string }): Promise<{ enqueued: boolean }>`
  - `retryCaptureUrlAction(input: { captureId: string }): Promise<{ ok: true } | { ok: false; error: string }>` in `inbox/actions.ts`, matching the `{ ok }` result shape `capture-edit-action.test.ts` already pins for `updateCaptureTextAction`.

- [ ] **Step 1: Write the failing test**

Extend `tests/integration/url-capture.test.ts`:

```ts
it("re-enqueues a failed fetch and clears the reason", async () => {
  const capture = await commands.createCapture(auth, { text: "https://example.com/broken" });
  await db.update(captures)
    .set({ processingState: "failed", failureReason: "The page could not be read: timeout.", fetchOutcome: "provider-unavailable" })
    .where(eq(captures.id, capture.id));
  const result = await commands.retryCaptureUrl(auth, { captureId: capture.id });
  expect(result.enqueued).toBe(true);
  const events = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, "capture.url_content_requested"));
  expect(events.filter((e) => (e.payload as { captureId?: string }).captureId === capture.id)).toHaveLength(2);
  const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
  expect(after.failureReason).toBeNull();
  expect(after.fetchOutcome).toBe("pending");
});

it("refuses to retry a capture with no address", async () => {
  const capture = await commands.createCapture(auth, { text: "a thought" });
  await expect(commands.retryCaptureUrl(auth, { captureId: capture.id }))
    .rejects.toMatchObject({ code: "conflict" });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/url-capture.test.ts`
Expected: FAIL — `retryCaptureUrl` is not exported.

- [ ] **Step 3: Implement the command**

Load the capture scoped by `auth.workspaceId`; a missing row is `NotFoundError`. Require `capture.url`, else `ConflictError("That capture has no address to read.")`. Require the caller to be `capture.createdBy` or an owner, matching conversion's rule. Inside `withTransaction` + `withReceipt`: update `failureReason: null, fetchOutcome: "pending"`, enqueue `CAPTURE_URL_CONTENT_TOPIC` with `dispatchKey: \`capture-url-retry:${captureId}:${Date.now()}\`` (a fresh key — the original key is already dispatched and would be deduped into nothing), and `recordAudit` with action `capture.url_retry_requested`.

- [ ] **Step 4: Add the server action**

In `actions.ts`, mirror the existing action's shape: authenticate, parse `{ captureId: z.string().uuid() }`, call `retryCaptureUrl`, `revalidatePath("/command-center/inbox")`, return `{ ok: true }`; on a thrown `ConflictError` or `NotFoundError` return its message as `{ ok: false, error }`. No new permission surface.

- [ ] **Step 5: Rewrite the handler's stale comment**

In `url-content-handler.ts`, the header says "There is no retry command yet" and cites ASH-318. Replace with the truth: a failed fetch is retried by `retryCaptureUrl`, and a re-paste of a failed address returns the existing capture.

- [ ] **Step 6: Run the tests**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/url-capture.test.ts tests/unit/capture-edit-action.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domains/capture/commands.ts src/domains/capture/url-content-handler.ts "src/app/(workspace)/command-center/inbox/actions.ts" tests/integration/url-capture.test.ts
git commit -m "feat(capture): retry a failed fetch without a second capture"
```

---

### Task 7: Carry the URL into the document

**Files:**
- Modify: `src/domains/capture/commands.ts:451-461` (`convertCaptureToDocument`)
- Test: `tests/integration/capture-to-document.test.ts` (extend)

**Interfaces:**
- Consumes: `intakeFile`'s existing `sourceUrl?: string` (`src/domains/knowledge/intake.ts:28`).
- Produces: nothing new. `documents.source_url` is populated, and `documents_workspace_source_url_key` means two captures of one article land on one document.

- [ ] **Step 1: Write the failing test**

```ts
it("carries the capture's url onto the document", async () => {
  const capture = await commands.createCapture(auth, {
    text: "converted body", url: "https://example.com/provenance", mode: "selection",
  });
  const converted = await commands.convertCaptureToDocument(auth, {
    captureId: capture.id, expectedVersion: capture.version,
  });
  const [doc] = await db.select().from(documents).where(eq(documents.id, converted.documentId));
  expect(doc.sourceUrl).toBe("https://example.com/provenance");
});

it("files two selections from one article onto one document", async () => {
  const url = "https://example.com/same-article";
  const a = await commands.createCapture(auth, { text: "part one", url, mode: "selection" });
  const b = await commands.createCapture(auth, { text: "part two", url, mode: "selection" });
  const first = await commands.convertCaptureToDocument(auth, { captureId: a.id, expectedVersion: a.version });
  const second = await commands.convertCaptureToDocument(auth, { captureId: b.id, expectedVersion: b.version });
  expect(second.documentId).toBe(first.documentId);
});
```

The second test is the one that proves the index does the work rather than a second document being created; check `convertCaptureToDocument`'s existing return shape before writing the assertion and use its actual field name.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-to-document.test.ts`
Expected: FAIL — `sourceUrl` is null.

- [ ] **Step 3: Implement**

Pass `sourceUrl: capture.url ?? undefined` in the `intakeFile` call. Use `workingText(capture)` in place of `(capture.cleanText ?? capture.text ?? "")` so a page capture files the fetched reading and a selection files the selection. Nothing else changes.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-to-document.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/capture/commands.ts tests/integration/capture-to-document.test.ts
git commit -m "fix(capture): carry url provenance into the converted document"
```

---

### Task 8: Enrichment degrades instead of failing

**Files:**
- Modify: `src/domains/capture/enrichment-handler.ts:18-20` (import), `:292-340` (`tryJevTriage`), `:222-224` and `:302-304` (stale comments), and the tier-0 normalization input
- Test: `tests/integration/capture-enrichment.test.ts` (extend)

**Interfaces:**
- Consumes: `QuotaExhaustedError` from `@/integrations/providers/quota` (already imported in that file for `withQuota`).
- Produces: no signature change. `tryJevTriage` returns `"fallback"` for a quota exhaustion, and the capture still reaches `enriched` through the generation ladder. When no generation provider is configured either, it reaches `enriched` via the existing `GenerationUnconfiguredError` path with a recorded `failureReason`.

- [ ] **Step 1: Write the failing test**

```ts
it("falls back to the deterministic ladder when Jev has no allowance", async () => {
  const capture = await commands.createCapture(auth, { text: "A sentence long enough to want a model." });
  // Jev is enabled in the registry; an unset allowance makes jevClassifier throw.
  vi.stubEnv("JEV_MONTHLY_INPUT_TOKENS", "0");
  await runEnrichment(capture.id);
  const [after] = await db.select().from(captures).where(eq(captures.id, capture.id));
  expect(after.processingState).toBe("enriched");
  expect(after.enrichmentLeaseToken).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-enrichment.test.ts`
Expected: FAIL — the handler throws and the state stays `classifying`.

- [ ] **Step 3: Implement**

Add `QuotaExhaustedError` to the import from `@/integrations/providers/quota` and to the fallback condition in `tryJevTriage`: `if (cause instanceof JevDisabledError || cause instanceof JevUnconfiguredError || cause instanceof QuotaExhaustedError) return "fallback";`. `JevRequestError` keeps throwing (redeliverable). Replace the two comments that say Jev "ships disabled" with the fact: it is enabled in the registry, and this ladder treats a missing allowance as skippable.

Also switch tier-0 normalization to take `workingText(capture)` rather than `capture.text`, so a `page` capture normalizes the fetched reading and a `selection` normalizes the selection. If `workingText` returns null (a `blob` awaiting transcription) keep today's behaviour unchanged.

- [ ] **Step 4: Run the tests**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/capture-enrichment.test.ts tests/unit/capture-jev-triage.test.ts tests/integration/capture-proposals.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/capture/enrichment-handler.ts tests/integration/capture-enrichment.test.ts
git commit -m "fix(capture): a missing Jev allowance degrades, it does not fail"
```

---

### Task 9: The route and the extension tell the truth

**Files:**
- Modify: `src/app/api/v1/captures/route.ts:19-27` (schema), `:56-71` (destructure + call)
- Modify: `extensions/chrome/api.js:54-100` (`base()`), `:177-197` (both capture functions), `:208-240` (`queueCapture`)
- Modify: `extensions/chrome/dashboard.js:181-190` (copy for the unconfirmed state)
- Test: `tests/unit/extension-capture-client.test.ts`, `tests/integration/captures-route.test.ts` (extend)

**Interfaces:**
- Consumes: `createCapture` accepting `mode` (Task 3).
- Produces:
  - The POST body accepts an optional `mode: "authored" | "selection" | "page" | "url-reference"`; omitted means inferred server-side, so an older extension build keeps working.
  - `AlfredAPI.capturePage` sends `mode: "page"`; `captureSelection` sends `mode: "selection"`; `dashboard.js`'s note path sends `mode: "authored"`.
  - `queueCapture` returns `{ ok: true, delivered: true }`, `{ ok: true, delivered: false, unconfirmed: true }`, or throws. It never returns `{ ok: true, delivered: false }` without `unconfirmed`.
  - `base()` throws `new Error("The configured server is unreachable.")` instead of falling back to `http://localhost:3000`.

- [ ] **Step 1: Write the failing route test**

Extend `tests/integration/captures-route.test.ts`:

```ts
it("records an explicit selection mode", async () => {
  const res = await post({ text: "fragment", url: "https://example.com/s", mode: "selection" });
  expect(res.status).toBe(201);
  const capture = (await res.json()).capture;
  expect(capture.captureMode).toBe("selection");
});

it("treats an address-only body as a url reference", async () => {
  const res = await post({ url: "https://example.com/bare" });
  expect(res.status).toBe(201);
  expect((await res.json()).capture.kind).toBe("url");
});

it("still accepts a body with no mode from an older extension", async () => {
  const res = await post({ text: "legacy", url: "https://example.com/legacy" });
  expect(res.status).toBe(201);
  expect((await res.json()).capture.captureMode).toBe("page");
});
```

Reuse the existing request helper in that file; if it has none, build the request with `authedHandler`'s test harness already used there rather than inventing one.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/captures-route.test.ts`
Expected: FAIL on the first and second.

- [ ] **Step 3: Change the route**

Add `mode: z.enum(["authored", "selection", "page", "url-reference"]).optional()` to `captureRequest` and pass it through. Fix the comment at `:13-15` which claims a page grab is "a text capture whose URL is provenance" — that is the misunderstanding this task removes.

- [ ] **Step 4: Write the failing extension test**

`tests/unit/extension-capture-client.test.ts` — the file assigns `window.AlfredAPI` at load, so stub the globals before importing:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

type Api = {
  base(): Promise<string>;
  captureSelection(a: Record<string, unknown>): Promise<{ ok: boolean; delivered: boolean; unconfirmed?: boolean }>;
};

async function loadApi(chromeStub: Record<string, unknown>): Promise<Api> {
  vi.resetModules();
  (globalThis as Record<string, unknown>).window = {};
  (globalThis as Record<string, unknown>).chrome = chromeStub;
  await import("../../extensions/chrome/api.js");
  return (globalThis as { window: { AlfredAPI: Api } }).window.AlfredAPI;
}

describe("capture client", () => {
  it("reports an unanswered enqueue as unconfirmed, not as a save", async () => {
    const api = await loadApi({
      runtime: { id: "x", sendMessage: vi.fn().mockRejectedValue({ code: "enqueue_unconfirmed" }) },
      storage: { local: { get: vi.fn().mockResolvedValue({}), set: vi.fn() } },
    });
    const result = await api.captureSelection({ url: "https://e.com/a", selectedText: "frag" });
    expect(result.ok).toBe(true);
    expect(result.delivered).toBe(false);
    expect(result.unconfirmed).toBe(true);
  });

  it("throws instead of falling back to localhost when the configured server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const api = await loadApi({
      runtime: { id: "x", sendMessage: vi.fn() },
      storage: { local: { get: vi.fn().mockResolvedValue({ alfredBaseUrl: "https://polymath.example" }), set: vi.fn() } },
    });
    await expect(api.base()).rejects.toThrow(/unreachable/i);
  });
});
```

`api.js` has no imports and touches `window`/`chrome`/`location` only inside functions or behind its trailing `if (_axiomRoot)` guard, so this loads under Vitest. If `_getStorage` turns out to read a different key or shape, read `api.js` and match it — do not change the stub to make a wrong assertion pass.

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm exec vitest run tests/unit/extension-capture-client.test.ts`
Expected: FAIL on both.

- [ ] **Step 6: Change `api.js`**

- `base()`: remove `this._baseUrl = this._defaultUrl` on both failure paths. When no stored URL exists at all, keep returning `_defaultUrl` (first-run local development depends on it); when a stored URL exists and the probe fails, throw the unreachable error.
- `capturePage` sends `mode: "page"`; `captureSelection` sends `mode: "selection"`. Drop the `" — selection"` title suffix (an em dash in a user-visible string, and the mode now carries the fact).
- `queueCapture` sends `mode` in the `AXIOM_ENQUEUE_CAPTURE` message and the direct-POST fallback. On `enqueue_unconfirmed`, return `{ ok: true, delivered: false, unconfirmed: true }`.

- [ ] **Step 7: Change `dashboard.js`**

Its note path calls `queueCapture` with `mode: "authored"`, and its else-branch says "Saved on this device. It will appear in the inbox once it syncs." Split it: `result.unconfirmed` says "Saved on this device. This browser could not confirm the server received it yet."; a plain `delivered: false` keeps the queued sentence.

- [ ] **Step 8: Run the tests**

Run: `pnpm exec vitest run tests/unit/extension-capture-client.test.ts && TEST_DATABASE_URL=... pnpm exec vitest run tests/integration/captures-route.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/app/api/v1/captures/route.ts extensions/chrome/api.js extensions/chrome/dashboard.js tests/unit/extension-capture-client.test.ts tests/integration/captures-route.test.ts
git commit -m "feat(companion): send capture mode and stop claiming an unproven save"
```

---

### Task 10: The inbox shows what the pipeline actually knows

**Files:**
- Modify: `src/app/(workspace)/command-center/inbox/inbox-detail.tsx:274-285` (generic body branch), `:369-372` (the voice hint), and add a fetch-state line beside the URL branch at `:256-273`
- Modify: `tests/e2e/voice-capture.spec.ts:49`
- Create: `tests/e2e/ingestion-selection.spec.ts`
- Test: the two specs above

**Interfaces:**
- Consumes: `capture.failureReason` (already passed to the component), `capture.fetchOutcome` (Task 2), `retryCaptureUrlAction` (Task 6).
- Produces: no exported API. The detail pane reports a failed voice capture's reason, and a URL capture's fetch state as a distinct fact from "reading now".

- [ ] **Step 1: Update the assertion this change invalidates**

`tests/e2e/voice-capture.spec.ts:49` asserts the exact sentence that must now change:

```ts
await expect(detail.getByText("The transcript lands here once transcription runs; then it works like any text capture.")).toBeVisible();
```

Replace with an assertion that holds for the state the fixture is in (an unconfigured transcription provider): the hint names the failure. Keep the other guarantees in that test untouched — the `?id=` URL at `:46`, the `"Voice"` label at `:48`, and `"Save as note"` having count 0 at `:50`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec playwright test tests/e2e/voice-capture.spec.ts` (headless; needs `E2E_BASE_URL` or `make dev`)
Expected: FAIL, because the UI still shows the generic sentence.

- [ ] **Step 3: Render the reason**

In the generic body branch, render `capture.failureReason` above `CaptureBody` when it is set, with `role="status"` and the same class as the URL branch's. In the `voiceWithoutTranscript` hint, replace the fixed sentence with the reason when `capture.failureReason` is set, keeping the existing sentence as the fallback. **No em dash in either string.**

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec playwright test tests/e2e/voice-capture.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the fetch-state line**

Beside the URL branch: when `capture.fetchOutcome` is `error-page`, `access-denied`, `empty`, or `provider-unavailable`, show the reason plus a `Retry` button calling `retryCaptureUrlAction`; when `acquired`, show nothing extra (the text speaks for itself); when `pending` or null, keep "Reading the page now." Wire the button the way the existing `saveAsNote` handler does — `startTransition`, `setError` on `{ ok: false }`.

- [ ] **Step 6: Write the selection journey spec**

`tests/e2e/ingestion-selection.spec.ts`:

```ts
test("a selection survives its page fetch and files with its provenance", async ({ page }) => {
  // Capture a selection through the API (the extension is not driven here), then
  // open it in the inbox and assert the selection is still the working text.
  // Assert the retry affordance appears only for a failed fetch.
});
```

Assert: the detail pane shows the selection text; the URL is present as provenance; after conversion the library document's page shows the article URL. Drive the capture through `request.post("/api/v1/captures", { data: { text, url, mode: "selection" } })` the way `voice-capture.spec.ts:15` posts its fixture, rather than driving the extension. Headless only.

- [ ] **Step 7: Run the whole gate**

```bash
make check
pnpm exec playwright test tests/e2e/ingestion-selection.spec.ts tests/e2e/voice-capture.spec.ts
```

Expected: `make check` passes; both specs pass headless. Paste the output of both into the PR — a description of what should happen is not evidence of what did.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(workspace)/command-center/inbox/inbox-detail.tsx" tests/e2e
git commit -m "feat(inbox): show a failed capture's reason and a fetch's real state"
```

---

## Phase 1 done when

- All eight acceptance checks in spec §4.8 pass, with their output in the PR.
- The four named unit tests still pass: `capture-detail-heading`, `capture-edit-action`, `refresh-inbox-action`, `zettel-generate-action`.
- `voice-capture.spec.ts` is updated, not merely green, and `ingestion-selection.spec.ts` exists.
- `make check` passes on a **clean** tree (commit first — `pnpm build` reads the working tree, so a passing build over uncommitted edits says nothing).
- Rollback stated: the migration is additive except the index swap. Reverting the code alone is safe; reverting the index needs a follow-up migration recreating `captures_workspace_source_url_key`, rehearsed on a Neon branch because it can fail against rows the new rules allowed.
