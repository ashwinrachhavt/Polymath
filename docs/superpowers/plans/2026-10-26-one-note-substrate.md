# One Note Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every text object in Polymath is one note — a markdown artifact with a template slug — with tasks keeping their state in a 1:1 extension row, so prose is stored, versioned and linked once.

**Architecture:** `artifacts` gains a `template` text column and stays the sole owner of prose. `tasks` gains a unique `note_id` and loses `title`/`description`. `src/domains/work/queries.ts` becomes the only file that joins artifacts for task prose, exposing an explicit `Task` type so the 20+ UI consumers compile unchanged. Two forward-only migrations: additive+backfill first, drop second, with the new code deployed between them.

**Tech Stack:** Next.js 16 (App Router, RSC), TypeScript strict, Drizzle ORM, Neon Postgres, Vitest, Biome/ESLint via `make check`.

**Spec:** `docs/superpowers/specs/2026-10-26-one-note-substrate-design.md`

## Global Constraints

- `strict: true`, no `any`, no non-null `!` on provider data.
- Every owned table has `workspace_id`; queries scope by `AuthContext`, never by client input.
- Migrations are forward-only and **never edited after they run**.
- Audit and outbox rows are written **in the same transaction** as the change they describe.
- Integration tests hit **real Postgres**, not mocks. `TEST_DATABASE_URL` must be set explicitly — it is empty in `.env`.
- Task vocabulary stays `task`; prose vocabulary stays `note`. A synonym is a bug (`agents/product.md`).
- No file outside `src/domains/work/` may contain a raw join to `artifacts` for task prose.
- Each non-trivial logic change leaves one runnable check.

## Review Focus

Places the spec implies but no single task's tests cover, most likely to bite first:

1. **A task whose body is empty.** Backfill writes an empty body when `tasks.description` is null. The note must render and open fullscreen without a "no content" failure, and it must not be indistinguishable from a failed read.
2. **Concurrent task creation.** `createTask` already takes an advisory lock to assign `rank`. Adding an artifact insert inside that same transaction must not deadlock or move the lock boundary.
3. **A note deleted while a task points at it.** The FK is `restrict`; the API must return a readable `problem+json` conflict, not a raw Postgres foreign-key error.
4. **Recurrence fan-out.** A template spawned 200 times produces 200 artifacts. Listing performance and the backfill's runtime must not degrade superlinearly.
5. **Autosave on a task body.** The note editor autosaves on a 1200ms debounce; a task body edit must not bump `tasks.updated_at`, or boards sorted by task activity reorder while the person is still typing.

Regression baseline to capture before Task 1 touches anything:

- [ ] **Step 1: Record the current task surface as a baseline**

Run: `cd /Users/ashwin/Projects/axiom-notebooklm && grep -rn 'tasks\.title\|tasks\.description' src | wc -l`
Expected: `28` (14 files). Save this number — the final task must bring it to zero outside `src/domains/work/queries.ts`.

- [ ] **Step 2: Confirm the suite is green before changing it**

Run: `npx vitest run tests/integration/tasks 2>&1 | tail -20`
Expected: PASS (or "no test files found" — record which, since a missing task suite is itself a finding).

---

### Task 1: Template registry moves to knowledge and gains `issue` / `todo`

**Files:**
- Move: `src/domains/capture/draft-templates.ts` → `src/domains/knowledge/templates.ts`
- Modify: `src/domains/capture/*` importers (grep `draft-templates`)
- Test: `tests/unit/draft-templates.test.ts`, `tests/unit/draft-linear-issue-template.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DRAFT_TEMPLATES: readonly ["email","product-spec","tech-spec","issue","todo"]`, `type DraftTemplate`, `DRAFT_TEMPLATE_LABEL: Record<DraftTemplate,string>`, `DRAFT_TEMPLATE_KIND: Record<DraftTemplate,"note">`, `draftTitle(template, firstLine): string`, `draftBody(template, {firstLine, material}): string`, all exported from `@/domains/knowledge/templates`.

Reason for the move, so the implementer does not undo it: tasks and specs consume templates too, so capture is no longer the owner. Capture keeps importing.

- [ ] **Step 1: Move the file with history preserved**

Run: `git mv src/domains/capture/draft-templates.ts src/domains/knowledge/templates.ts`

- [ ] **Step 2: Rename the vendor-named template and add `todo`**

In `src/domains/knowledge/templates.ts`, change the const tuple to `["email","product-spec","tech-spec","issue","todo"]` and the label map to `issue: "Issue"`, `todo: "Todo"`. Do not add a `linear-issue` alias — two slugs for one scaffold is the synonym bug.

- [ ] **Step 3: Add the `issue` and `todo` body cases**

`issue` takes the existing `linear-issue` branch verbatim (it is the same scaffold, renamed). `todo` builds a three-section body: the first line as an `## Task` heading, a `## Notes` section with `[What done looks like.]`, and no source-material section — a todo has no captured source to stay faithful to.

- [ ] **Step 4: Update the two tests and every importer**

Run: `grep -rln 'draft-templates' src tests` and rewrite each import path to `@/domains/knowledge/templates`. In `tests/unit/draft-linear-issue-template.test.ts`, rename the file to `test/unit/draft-issue-template.test.ts` and the template id to `issue`.

- [ ] **Step 5: Run the template tests**

Run: `npx vitest run tests/unit/draft-templates.test.ts tests/unit/draft-issue-template.test.ts`
Expected: PASS, with the `issue` case asserting the branch scaffold and the `todo` case asserting no `## Source material` section.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(templates): move the draft registry to knowledge and add issue/todo"
```

---

### Task 2: Additive migration — columns and backfill

**Files:**
- Create: `src/db/migrations/0257_one_note_substrate_add.sql`
- Modify: `src/domains/knowledge/schema.ts` (`artifacts.template`)
- Modify: `src/domains/work/schema.ts` (`tasks.noteId`)
- Test: `tests/integration/one-note-substrate-backfill.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `artifacts.template: text | null`; `tasks.noteId: uuid | null` (unique index arrives in Task 7).

- [ ] **Step 1: Write the failing backfill test**

Seed two tasks in one transaction — one with a description, one with `description: null` — then run the backfill SQL and assert: each task gains a non-null `note_id`; the described task's artifact has `template = 'issue'` and a version whose `plain_text` equals its description; the undescribed task's artifact has one version with an empty body and does not fail; `workspace_id` matches on every created row.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-backfill.test.ts`
Expected: FAIL — column `template` / `note_id` does not exist.

- [ ] **Step 3: Write the additive migration**

`0257_one_note_substrate_add.sql` follows the repo's shape (see `0253_run_reviews.sql`): guarded DDL, `--> statement-breakpoint` between statements, one comment block at the top explaining why. The backfill is a single `INSERT ... SELECT` into `artifacts`, a second into `artifact_versions`, and an `UPDATE tasks SET note_id` joined on the artifact's `produced_by_run_id`-free correlation key — use a temporary correlation column if needed rather than matching on title, because two tasks may share a title. Mark file `src/db/migrations/meta/` snapshot regeneration via the project's drizzle command if the repo requires it.

- [ ] **Step 4: Mirror both columns in the Drizzle schemas**

Add `template: text("template")` to `artifacts` in `src/domains/knowledge/schema.ts` and `noteId: uuid("note_id").references(() => artifacts.id)` to `tasks` in `src/domains/work/schema.ts`.

- [ ] **Step 5: Run the backfill test**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-backfill.test.ts`
Expected: PASS.

- [ ] **Step 6: Prove idempotence**

Extend the same test: run the backfill a second time and assert the artifact count is unchanged and no version is duplicated. This is the check that catches a backfill that re-creates rows on retry.

- [ ] **Step 7: Pin the recurrence fan-out (Review Focus 4)**

Seed one recurrence template with 200 spawned instances and run the backfill. Assert 200 artifacts exist, one per instance, and that the run completes in a single statement set — not one statement per task. The check is the artifact count plus the statement shape; if the backfill was written as a loop, this is where it shows.

- [ ] **Step 8: Commit**

```bash
git add src/db src/domains/knowledge/schema.ts src/domains/work/schema.ts tests/integration/one-note-substrate-backfill.test.ts
git commit -m "feat(schema): add artifacts.template and tasks.note_id with backfill (0257)"
```

---

### Task 3: Explicit `Task` type with prose joined in

**Files:**
- Modify: `src/domains/work/queries.ts:79-90` (`TaskDetail`), plus every `select()` in the file naming `tasks.title` / `tasks.description`
- Test: `tests/integration/work-task-prose.test.ts`

**Interfaces:**
- Consumes: `artifacts.title`, `artifacts.id` from Task 2.
- Produces:
  ```ts
  export type Task = {
    id: string; title: string; description: string | null;
    status: (typeof tasks.$inferSelect)["status"];
    priority: (typeof tasks.$inferSelect)["priority"];
    rank: string; version: number;
    dueAt: Date | null; plannedStartAt: Date | null; plannedEndAt: Date | null;
    estimateMinutes: number | null; tags: unknown; projectId: string | null; spaceId: string | null;
    parentTaskId: string | null; completedAt: Date | null; cancelledAt: Date | null;
    createdAt: Date; updatedAt: Date; archivedAt: Date | null;
  };
  export type TaskDetail = { task: Task; subtasks: ...; blockedBy: ...; blocking: ...; waitingOn: ... };
  ```
  `TaskDetail.task` changes from `typeof tasks.$inferSelect` to `Task`.

- [ ] **Step 1: Write the failing read test**

Assert `getTaskDetail` returns a `task.title` equal to the artifact's title and a `task.description` equal to the note body's `plain_text`, for a task created by the backfill. Assert a subtask's `title` also resolves through the join.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-task-prose.test.ts`
Expected: FAIL — `task.title` still reads the task column, giving the pre-move value.

- [ ] **Step 3: Declare the explicit `Task` type and join**

Replace the inferred type with the declaration above, and change each `select()` in `queries.ts` that names `tasks.title` or `tasks.description` to an inner join on `artifacts` selecting `artifacts.title as title` and `artifacts.title`/`plainText` projection as `description`. Subtask and dependency peer title lookups join on the same primary key; keep each read to one round trip (no N+1).

- [ ] **Step 4: Run the test and the typecheck**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-task-prose.test.ts && npx tsc --noEmit 2>&1 | tail -20`
Expected: PASS and no new type errors. Any file now failing to compile is a consumer of the old inferred shape — list it for Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/domains/work/queries.ts tests/integration/work-task-prose.test.ts
git commit -m "feat(work): join task prose from the artifact and declare Task explicitly"
```

---

### Task 4: `createTask` writes the note in the same transaction

**Files:**
- Modify: `src/domains/work/commands.ts:44-95`
- Test: `tests/integration/work-create-task-note.test.ts`

**Interfaces:**
- Consumes: `tasks.noteId`, `artifacts.template`, the `issue` template from Task 1.
- Produces: `createTask` returns `{ id, noteId, version, ... }` — the task row plus a non-null `noteId`.

- [ ] **Step 1: Write the failing test**

Assert that `createTask({ title, description })` produces exactly one `artifacts` row (`kind: "note"`, `template: "issue"`), one `artifact_versions` row at version 1 whose plain text is the description, one `tasks` row with `note_id` set, and one audit row — all with the same `workspace_id`. Assert `createTask` with no description still creates the version with an empty body.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-create-task-note.test.ts`
Expected: FAIL — no artifact row is created.

- [ ] **Step 3: Insert the artifact before the task inside the existing transaction**

Reuse the artifact+version+`current_version_id` sequence from `src/domains/knowledge/notes.ts:184-200` rather than writing a second variant. The artifact insert goes after the existing advisory-lock rank computation and inside the same `tx`, so the lock boundary does not move (Review Focus 2). `tasks.title` stops being written.

- [ ] **Step 4: Run the test plus the existing task suite**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-create-task-note.test.ts tests/integration/tasks 2>&1 | tail -30`
Expected: PASS. A deadlock or lock-timeout here means the artifact insert landed outside the lock — fix the ordering, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/domains/work/commands.ts tests/integration/work-create-task-note.test.ts
git commit -m "feat(work): createTask writes its note in the same transaction"
```

---

### Task 5: Body edits are versioned, and do not bump task activity

**Files:**
- Modify: `src/domains/work/task-commands.ts:128`
- Test: `tests/integration/work-task-body-versioning.test.ts`

**Interfaces:**
- Consumes: the note update commands from `src/domains/knowledge/notes.ts`.
- Produces: patching `description` routes to the note body; `tasks.updated_at` is unchanged by a body-only edit.

- [ ] **Step 1: Write the failing test**

Assert three things: patching `description` on a task mints artifact version 2 with the new plain text; `tasks.updated_at` does not move across that patch; patching `status` alone writes exactly one row and touches no artifact.

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-task-body-versioning.test.ts`
Expected: FAIL — the patch still writes `tasks.description`.

- [ ] **Step 3: Route the description patch to the note command**

Remove `description` from the task `set` object at `task-commands.ts:128` and route it to the note's version commit inside the same transaction. Leave status/priority/due/rank/estimate writing the task row only — those must not touch the artifact (Review Focus 5 asserts the reverse direction).

- [ ] **Step 4: Run the test**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/work-task-body-versioning.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domains/work/task-commands.ts tests/integration/work-task-body-versioning.test.ts
git commit -m "feat(work): task body edits version the note and leave task activity alone"
```

---

### Task 6: Route the 11 downstream files through the domain query

**Files:**
- Modify: `src/domains/calendar/commands.ts`, `src/domains/focus/queries.ts`, `src/domains/focus/follow-up.ts`, `src/domains/knowledge/debt.ts`, `src/domains/knowledge/meeting-prep.ts`, `src/domains/daybook/shutdown.ts`, `src/domains/import/inventory-import.ts`, `src/domains/work/reports.ts`, `src/domains/work/proposals.ts`, `src/app/(workspace)/projects-links.ts`, `src/components/shell/shell-actions.ts`
- Test: covered by the typecheck plus one integration assertion per domain that has a test today

**Interfaces:**
- Consumes: `Task`, `getTaskDetail`, and the task list queries from Task 3.
- Produces: no new exports; these files stop naming dropped columns.

- [ ] **Step 1: Enumerate the exact call sites**

Run: `grep -rn 'tasks\.title\|tasks\.description' src` and record each hit outside `src/domains/work/queries.ts`. Each becomes either a call to an existing task query or a change to select the joined `Task` shape.

- [ ] **Step 2: Rewrite each call site, and nothing else**

No new abstraction, no repository layer, no helper introduced for a single caller. Where a file needs one title, expose a narrow query in `work/queries.ts` and call it — the join stays in that file.

- [ ] **Step 3: Prove the sweep is complete**

Run: `grep -rn 'tasks\.title\|tasks\.description' src`
Expected: hits only inside `src/domains/work/queries.ts`. Zero elsewhere.

- [ ] **Step 4: Typecheck and run the affected domain tests**

Run: `npx tsc --noEmit 2>&1 | tail -20 && npx vitest run tests/integration 2>&1 | tail -30`
Expected: clean typecheck; no new failures.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: route every task prose reader through the work domain query"
```

---

### Task 7: The drop migration

**Files:**
- Create: `src/db/migrations/0258_one_note_substrate_drop.sql`
- Modify: `src/domains/work/schema.ts` (remove `title`, `description`)
- Test: `tests/integration/one-note-substrate-drop.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `tasks.noteId` NOT NULL + unique index `tasks_note_key`; `tasks.title` and `tasks.description` gone.

- [ ] **Step 1: Write the failing test**

Assert that inserting a task with a null `note_id` is rejected, that a second task reusing an existing `note_id` is rejected by `tasks_note_key`, and that deleting an artifact whose id backs a task fails on the foreign key rather than cascading (Review Focus 3 — the API must surface this as a `409` conflict, so assert the constraint here and the friendly error in the route test if one exists).

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-drop.test.ts`
Expected: FAIL — both constraints are absent.

- [ ] **Step 3: Write the drop migration**

`0258_one_note_substrate_drop.sql`: `DO $$ ... $$` block that raises if any `note_id is null`; then `SET NOT NULL`; then `CREATE UNIQUE INDEX tasks_note_key`; then `DROP COLUMN title`, `DROP COLUMN description`. The abort must precede the drops so a partial migration can never land.

- [ ] **Step 4: Remove the columns from the Drizzle schema**

Delete `title` and `description` from `tasks` in `src/domains/work/schema.ts`.

- [ ] **Step 5: Run the test and the full suite**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-drop.test.ts tests/integration 2>&1 | tail -30`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db src/domains/work/schema.ts tests/integration/one-note-substrate-drop.test.ts
git commit -m "feat(schema): require tasks.note_id and drop the task prose columns (0258)"
```

---

### Task 8: Tenancy, template validation, and the empty body

**Files:**
- Modify: `src/domains/work/commands.ts` (template validation), `src/domains/knowledge/templates.ts` (a `resolveTemplate` guard)
- Test: `tests/integration/one-note-substrate-invariants.test.ts`

**Interfaces:**
- Consumes: `DRAFT_TEMPLATES` from Task 1.
- Produces: `resolveTemplate(slug: string | null): DraftTemplate | null` — returns null for an unknown slug; throws `problem+json` `unknown_template` on write.

- [ ] **Step 1: Write the three failing invariant tests**

(a) A task and its note always share a `workspace_id`, and a hand-written task insert carrying another workspace's `note_id` is rejected. (b) An unknown template slug is rejected on write with code `unknown_template` and renders as a plain note on read without throwing. (c) A task whose body is empty (Review Focus 1) opens through the note read path and returns an empty markdown body, not null and not an error.

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-invariants.test.ts`
Expected: FAIL on all three.

- [ ] **Step 3: Implement `resolveTemplate` and the tenancy check**

Tenancy is enforced in the database, not only in code: add the check to the migration in Task 7 if the constraint is expressible, otherwise enforce it in `createTask` by asserting `artifacts.workspace_id === auth.workspaceId` inside the transaction. An unknown slug on read degrades to a plain note rather than throwing, because deleting a template must never break reading an existing note.

- [ ] **Step 4: Run the invariants**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npx vitest run tests/integration/one-note-substrate-invariants.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(notes): pin tenancy, template validation and the empty body"
```

---

### Task 9: Amend the stance document and prove the surface

**Files:**
- Modify: `agents/product.md` (the twelve-core-resources decision), `agents/architecture.md` if it names task ownership
- Test: none new; this task's evidence is the full suite plus the grep

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Amend `agents/product.md`**

Under "Decisions already made", amend the twelve-core-resources bullet: `tasks` is a 1:1 extension of `notes`, not a parallel text resource; prose is stored once, in the artifact. Keep the "one record, many views" principle and say explicitly that this change *enforces* it. Do not delete the bullet — amend it, so a future reader sees the reversal and its reason.

- [ ] **Step 2: Run the full gate**

Run: `make check`
Expected: lint, typecheck, build and tests all pass.

- [ ] **Step 3: Prove the prose columns are gone**

Run: `grep -rn 'tasks\.title\|tasks\.description' src`
Expected: hits only in `src/domains/work/queries.ts`.

- [ ] **Step 4: Commit**

```bash
git add agents/product.md
git commit -m "docs(agents): a task is an extension of a note, not a second text store"
```
