# One note substrate — every text object is a note

**Date:** 2026-10-26
**Status:** Design, approved in shape; not implemented
**Ticket:** ASH-174 (Notes), extended by operator decision 2026-10-26

## Intent

A note, a todo item, a ticket, a product spec, and an email draft are the same
kind of thing: text a person wrote, edited in the same editor, versioned the
same way, linkable in the same graph. Today they are not. A task carries its own
`title` and `description` columns and never touches the artifact version
machinery; a note lives in `artifacts` + `artifact_versions` and never appears on
a board. The operator's decision (2026-10-26) is that this duplication ends.

> "A todo item, ticket or issue is a specialized note object using the issue
> template. A product spec is a specialized template, but still a notes markdown
> object. So for text I want everything to be a notes-based markdown object."

This is the foundational spec. It changes the data model only; the Notes surface
(wider editor, fullscreen, card → modal → fullscreen), the writing brief with a
supervisor run, and capture's optional "why" are three further specs that build
on it.

## What this reverses, and why that is allowed

`agents/product.md` lists among decisions already made: twelve core resources
with `tasks` and `notes` as separate things, and *"One record, many views: a
second task store to get a nicer screen is a bug."* This spec keeps the second
half of that rule and enforces it harder — there is now one store for prose, not
two — while amending the first: a task is a *view and an extension* of a note,
not a parallel text resource.

The operator made this decision explicitly. The amendment to `agents/product.md`
ships in the same change, because a stance document that contradicts the schema
is worse than either alone.

## The three decisions

1. **Template is a code registry, not a table.** A template is a scaffold, a
   label, and an optional body builder. It has no per-workspace state, no rows to
   migrate, and no query path. `src/domains/capture/draft-templates.ts` already
   models exactly this and is extended rather than replaced.
2. **A task is a note plus a 1:1 extension row.** The note owns the prose; `tasks`
   keeps scheduling and state. Chosen over folding task columns onto `notes`
   because 9 tables (`spaces`, `projects`, `boards`, `board_columns`,
   `saved_views`, `recurrence_templates`, `task_dependencies`, `task_links`) and
   29 importing files reference the current shape, and because a board that
   filters on `status` should not scan every note in the workspace.
3. **Sources and documents are not templated.** A captured article is immutable
   evidence with provenance, not an editable note. Templating it would let a
   person edit the thing they cited. Zettels already bridge evidence and notes.

## Data model

Two column changes. Nothing else in the schema moves.

```sql
ALTER TABLE "artifacts" ADD COLUMN "template" text;
ALTER TABLE "tasks"     ADD COLUMN "note_id" uuid REFERENCES "artifacts"("id");
CREATE UNIQUE INDEX "tasks_note_key" ON "tasks" ("note_id");
```

`artifacts.template` — the scaffold slug (`issue`, `todo`, `product-spec`,
`tech-spec`, `email`), or `NULL` for a plain note. Deliberately `text` and not an
enum: templates are code, and a new template must not require a migration. The
registry validates the value on write; a row holding an unknown slug renders as a
plain note rather than failing, so deleting a template can never break reading an
existing note.

`tasks.note_id` — unique, so a note backs at most one task. Nullable during the
backfill and left nullable afterwards only for the duration of one release; see
"Migration" for the enforcement step.

### Dependencies are not duplicated

`task_dependencies`, `task_links`, `boards`, `saved_views`, `recurrence_templates`
and `projects` all key off `tasks.id`, which does not change. `artifact_links`
already accepts `target_type = 'task'`, so linking a note to a task keeps
targeting the task id. No link rows are migrated.

## Template registry

`src/domains/capture/draft-templates.ts` becomes the single registry and moves to
`src/domains/knowledge/templates.ts` — it is no longer a capture concern now that
tasks consume it. Capture keeps importing it.

The registry gains two entries and one rename:

| Slug | Label | Body builder |
|---|---|---|
| `issue` | Issue | heading, context, acceptance, source material (renamed from `linear-issue`, which was the same scaffold under a vendor name) |
| `todo` | Todo | title plus optional checklist, no source-material section |
| `product-spec`, `tech-spec`, `email` | unchanged | unchanged |

`linear-issue` is replaced rather than aliased: two slugs for one scaffold is a
synonym, and `agents/product.md` calls a synonym a bug. Existing artifacts carry
no template value, so no data migration is needed — only the two call sites and
`tests/unit/draft-linear-issue-template.test.ts` and
`tests/unit/draft-templates.test.ts` are updated.

A task's default template is `issue`. A note created from the Notes "New note"
button gets `NULL` (a plain note), not a template — capture must stay
decision-free.

## Reads: the join stays behind the domain boundary

The goal is that callers keep reading `task.title` and never learn the prose moved.
Two things are required to get there, and the second is the real cost.

**1. Stop inferring the row type.** `TaskDetail.task` is currently
`typeof tasks.$inferSelect` (`queries.ts:80`), so dropping the columns silently
reshapes a type that 20+ UI files consume. `queries.ts` must declare the task
shape explicitly instead of deriving it from the table:

```ts
export type Task = {
  id: string;
  title: string;              // artifacts.title
  description: string | null; // the note body's plain-text projection
  status: TaskStatus;
  priority: TaskPriority;
  // ...the remaining columns, now written out rather than inferred
};
```

`TaskDetail.task` becomes `Task`. Callers that go through these types compile
unchanged.

**2. Fix the 14 files that name the columns directly.** This is larger than it
first appears. `tasks.title` and `tasks.description` are referenced 28 times
across 14 files, and several of those are outside the work domain:

| File | What it reads |
|---|---|
| `src/domains/work/queries.ts` | subtask titles, dependency peer titles, task cards |
| `src/domains/work/commands.ts`, `task-commands.ts`, `proposals.ts`, `reports.ts` | create, patch, proposal payload, reports |
| `src/domains/calendar/commands.ts` | calendar entry labels |
| `src/domains/focus/queries.ts`, `follow-up.ts` | focus session targets |
| `src/domains/knowledge/debt.ts`, `meeting-prep.ts` | task titles in knowledge surfaces |
| `src/domains/daybook/shutdown.ts` | today's committed outcomes |
| `src/domains/import/inventory-import.ts` | imported task creation |
| `src/app/(workspace)/projects-links.ts`, `src/components/shell/shell-actions.ts` | navigation labels |

Each becomes either a join through `work/queries.ts` or a call to a task query
that already joins. **No file outside `src/domains/work/` may contain a raw join
to `artifacts` for task prose** — they call the domain query, per the boundary
rule in `agents/coding.md`. That keeps the leak from spreading to 14 places
permanently; the joins live in one file.

The join is a primary-key lookup, and `tasks_workspace_status_idx` still drives
board and list filtering, so no hot query loses its index. Subtask and dependency
titles inside `queries.ts` become joins on the same PK and stay in one round trip.

Rule: `work/queries.ts` is the only file that knows prose lives on the artifact.
If a second file starts joining `artifacts` to render a task, the abstraction has
leaked and the fix is there, not at the new call site.

## Writes

Task creation and update become artifact commands that also write the task row,
in one transaction. Following `agents/coding.md`: authenticate → resolve
`AuthContext` → parse → idempotency + version → domain command → audit and outbox
in the same transaction → invalidate tags.

**Create a task** (`createTask`): insert `artifacts` (kind `note`, template
`issue`) → insert `artifact_versions` v1 with the body → insert `tasks` with
`note_id` → audit → outbox. One transaction; a task with no note is not
representable.

**Edit a task's body** (fullscreen in the Notes editor): the existing note
autosave and checkpoint commands run unchanged, because it *is* a note. Autosave
writes the working draft; a checkpoint mints a version. Task text therefore gains
version history it never had, which is the intended gain, not a side effect.

**Rename a task**: writes `artifacts.title`. `tasks.title` no longer exists.

**Change status, priority, due, rank, estimate**: unchanged, `task-commands.ts`
only. These never touch the artifact, so a board drag stays a single-row write.

## Migration

Forward-only, one migration (`0257_one_note_substrate.sql`), rehearsed on a Neon
branch before it runs anywhere shared. `agents/coding.md` forbids editing it after
it runs.

1. Add `artifacts.template` and `tasks.note_id`.
2. Backfill: for every existing task, create one artifact per task —
   `kind = 'note'`, `template = 'issue'`, `title` copied from `tasks.title`, one
   `artifact_versions` row holding `tasks.description` (or an empty body when
   null), `workspace_id` and `created_by` copied from the task. Set
   `tasks.note_id`. This runs in SQL and must be idempotent by construction
   (`WHERE note_id IS NULL`), because a re-run after a partial failure is the
   realistic failure mode.
3. Verify inside the migration: abort if any task still has a null `note_id`.
4. Set `tasks.note_id` NOT NULL.
5. Drop `tasks.title` and `tasks.description`.

Steps 4 and 5 are the irreversible ones. They land in the same migration as the
backfill rather than a later one, because a half-migrated schema where a task has
both a body column and a note is a state where two writers can disagree.

**Volume.** Recurrence is the risk: a daily recurring task that already spawned
200 instances produces 200 artifacts. This is accepted, because each instance's
body is independently editable and versioned per artifact. Ceiling noted per
`agents/coding.md`: if workspace artifact counts become dominated by recurrence
instances, the upgrade path is one shared note per recurrence template, cloned on
first edit rather than at spawn. That is a later change and not built now.

## What breaks, and how

- `src/domains/work/commands.ts:76` writes `description` on create — becomes the
  artifact body.
- `src/domains/work/task-commands.ts:128` patches `description` — becomes a body
  update routed to the note command.
- `src/domains/work/proposals.ts:58,67,204` carries `description` in an action
  proposal payload and preview — the payload keeps the key; the proposal's apply
  step writes it to the note body. No external contract changes.
- The 11 non-work files listed under "Reads" read the dropped columns directly
  and must route through `work/queries.ts`. They are the schedule risk in this
  change, not the schema.

The checklist that proves the work is done: `grep -rn 'tasks\.title\|tasks\.description' src`
returns no hits outside `src/domains/work/queries.ts`. Until it does, a caller is
still reading a column that no longer exists.

## Error handling

- **A note write that would orphan a task body.** Not possible structurally:
  the body lives on the artifact and the task references it with
  `ON DELETE` semantics chosen as `restrict` — deleting a note that backs a task
  is refused, because silently deleting a person's task by deleting a note is
  data loss. Archiving is the supported path.
- **Unknown template slug** on read renders as a plain note. On write, the
  registry rejects it with a `problem+json` 422 and a stable code
  (`unknown_template`).
- **Version conflict** on a task body edit returns the existing CAS conflict the
  note editor already handles — `409`, expected version in the body.
- **Backfill partial failure** leaves `tasks.note_id` null and aborts at step 3,
  so the schema never reaches NOT NULL with nulls present.

## Testing

Invariants run against real Postgres, per `agents/coding.md` — mocks prove the
mock works.

1. **Create task → note exists.** One task row, one artifact (template `issue`),
   one version, one audit row. A task with no note cannot be inserted.
2. **Board and list reads are unchanged.** A task created by `createTask` appears
   on a board with its title, and its `description` equals the note body's
   plain-text projection.
3. **Body edit is versioned.** Editing a task body fullscreen to a checkpoint
   mints artifact version 2 and leaves `tasks` untouched — the row's `updated_at`
   does not move on a body-only edit, so a board sort by task activity is not
   perturbed by typing.
4. **Status change does not touch the artifact.** One board drag writes exactly
   one row. This is the check that catches an accidental "save the whole task
   through the note path" regression.
5. **Backfill is idempotent.** Run it twice against a seeded fixture; artifact
   count is stable and no version is duplicated.
6. **Delete is refused.** Deleting an artifact that backs a task fails with a
   foreign-key error rather than cascading.
7. **Tenancy.** A task's note and the task carry the same `workspace_id`; a
   cross-workspace `note_id` is rejected. This is the invariant that most
   plausibly breaks in a hand-written backfill.
8. **Template registry.** An unknown slug is rejected on write and renders as a
   plain note on read, with no exception escaping to the page.

One runnable check per invariant, per the repo's rule; no markup snapshots.

## Out of scope, deliberately

- **Notes surface** (wider column, fullscreen mode, card → modal → fullscreen,
  `[[links]]` rendered as hyperlinks). Next spec. Note for the reader: `[[Title]]`
  links already create `artifact_links` edges today (`notes.ts:45`), so that work
  is a rendering gap, not a storage gap.
- **Writing brief and supervisor run** (target audience, target length driving
  loop and tool budgets, assess → plan → delegate, live tool pills). Third spec.
  Pill rendering must extend the live `chain-of-thought.tsx` path;
  `src/components/chat/tool-pills.tsx` is currently unused code with no importers
  and is deleted rather than revived.
- **Capture "why does this matter"**. Fourth spec. Copy-on-convert inside the
  conversion transaction, no propagation afterwards.
- **Sources, documents, vault.** Untouched by this spec.

## Coordination

- `src/domains/work/**` is being redesigned concurrently by another session
  (`axiom-9e`). This spec changes the shape that redesign sits on, so the
  migration lands before that work merges, or the two are rebased together.
  Requested from them: which in-flight files read task body text, and whether
  they own the migration or rebase onto it.
- `getBriefing(localDate)` in `src/domains/work/briefing.ts` survives the
  concurrent Briefing-page deletion and is the reader the writing brief will use
  for "today's context".
- The amendment to `agents/product.md` (task is a note plus an extension, not a
  parallel text resource) ships with the implementation, not before it.
