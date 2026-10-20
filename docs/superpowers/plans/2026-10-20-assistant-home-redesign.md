# Assistant home redesign — implementation plan

**Spec:** the redesign brief of 2026-10-20 (Assistant becomes the landing page;
navigation, one composer, compact history) plus two rulings made in the
brainstorming session:

1. **Chat is home.** The root URL lands on `/alfred`, reversing
   `agents/product.md`'s "briefing before browsing". Today moves to the second
   rail slot.
2. **Run detail folds into a disclosure.** The timeline, citations, model,
   tools, and budget move onto a per-conversation page under a `<details>`.
   Approvals stay in `/reviews`; they are not duplicated inline.

**Branch:** `feat/eve-agents-chat-composio`.

---

## Global constraints

- **No new dependencies.** Everything below is Next 16, React 19, Tailwind,
  existing `lucide-react` icons, and components already in `src/components`.
- **`agents/coding.md` applies.** Server components compose the view model;
  client islands only where interaction demands it; no `"use client"` at the
  top of a page.
- **Vocabulary is fixed** by `agents/product.md`: *run*, *thread*, *conversation*
  are not interchangeable. The rail item is **Assistant**; the rows beneath the
  composer are **recent conversations**; each row is one *run*.
- **Delete, do not hide.** The brief says remove copy, not restyle it into a
  secondary position. The exceptions it names explicitly are the Details
  disclosure and approvals.
- **No new taglines, onboarding cards, metrics, or extra suggestion sections.**
  The brief forbids replacing removed copy with new chrome.
- **One status per conversation row.** Never render two conflicting states.
- **`make check` / `pnpm check` must pass** before the last task is complete.
- **Existing tests that assert the old home must be updated, not deleted** —
  `tests/e2e/smoke.spec.ts:6` and `:25`.

---

## Task 1 — Make Assistant the landing page

**Files:** `src/app/page.tsx`, `src/lib/navigation.ts`, `src/components/shell/side-nav.tsx`
(only if it assumes `destinations[0]` is home), `agents/product.md`,
`tests/e2e/smoke.spec.ts`.

### What changes

**`src/app/page.tsx`** — the redirect target and its comment:

```tsx
import { redirect } from "next/navigation";

/*
 * The Assistant is home: the product's first move is a conversation, not a
 * browse. Today is one click away and still the day's decision surface — the
 * briefing did not stop mattering, it stopped being the front door.
 */
export default function Home() {
  redirect("/alfred");
}
```

**`src/lib/navigation.ts`** — two edits:

1. `homeHref` becomes `"/alfred"`.
2. The `Assistant` entry moves to index 0 and `Today` to index 1. Everything
   else keeps its order. Update the file's header comment where it explains the
   rail ordering, if it does.

The `Assistant` destination's `purpose` also changes — it currently reads
"Hand off work and inspect what it did." and the brief removes that subtitle
from the page. Use `"Start or continue a conversation."` in the navigation
entry so the command layer and breadcrumb stay accurate.

**`agents/product.md`** — the sentence that makes briefing home. Find it and
replace with a statement that a conversation is the first move and Today is one
click away. Do not touch anything else in that file.

**`tests/e2e/smoke.spec.ts`** — the test named "home opens the Today briefing"
(`:6`) and the assertion at `:25` both change to `/alfred`. The rest of the file
keeps its assertions.

### Acceptance

```sh
pnpm typecheck
pnpm exec playwright test tests/e2e/smoke.spec.ts --grep "home"
```

Both green. Visiting `/` lands on `/alfred`; the rail shows Assistant above
Today.

### Do not

- Reorder the rest of the rail.
- Rename the `/alfred` URL. It keeps its historic prefix (see
  `src/lib/navigation.ts` header comment).
- Change `/more` or `featureDestinations`.

---

## Task 2 — The home screen: composer and recent conversations

**Files:** rewrite `src/app/(workspace)/alfred/page.tsx`; new
`src/app/(workspace)/alfred/new-conversation.tsx` (client); keep
`src/app/(workspace)/alfred/start-run-form.tsx` only if Task 3 reuses it —
otherwise delete it.

### The screen, in order

```
┌──────────────────────────────────────────────┐
│                                              │
│         What would you like to work on?      │   ← centered greeting
│                                              │
│  ┌────────────────────────────────────────┐  │
│  │ Ask anything or describe a task…       │  │   ← composer, autofocused
│  │                                    [↑] │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  Recent                                      │   ← only when runs exist
│  ──────────────────────────────────────────  │
│  Design the provider gateway      2h    ●    │
│  Reconcile product management     1d         │
│                                              │
└──────────────────────────────────────────────┘
```

**On a fresh workspace** (no runs): greeting and composer only. No "Recent"
heading, no empty-state box, no explanation.

### Rules this screen follows

| Rule | Implementation |
|---|---|
| No `PageHeader` | The rail item establishes context. Do not render one. |
| No "Start a run", no explanatory paragraph | Nothing above the composer but the greeting. |
| Placeholder exactly | `Ask anything or describe a task…` |
| Compact send button | An icon button (`ArrowUp` from `lucide-react`, already used in `chat-surface.tsx`), `aria-label="Send"`, disabled while empty or pending. Not a labelled "Start" button. |
| Greeting | `What would you like to work on?` — one `<h1>`, `text-xl` or `text-2xl`, `font-medium`, centered. No period. |
| Recent list | Heading `Recent`, no subtitle. Rows: title, relative time, status **only when it needs attention**. |
| No filters, no search, no count | `ListToolbar`, `Pagination`, `NoResults` are all removed from this page. |
| No suggestion chips | The brief says use only existing capabilities *if* chips are included; it also forbids decorative additions. Omitting them is the smaller change and loses nothing. |

### Recent row rendering

Each row is a `<Link href={`/alfred/${run.id}`}>` (Task 4 creates that page).

- **Title:** `run.objective`, truncated to one line.
- **Time:** a relative timestamp from `createdAt` (`2h`, `1d`, `3d`). There is
  `formatThreadTime` in `src/domains/conversations/queries.ts` — reuse it rather
  than writing a second formatter.
- **Status:** render a badge **only** for `waiting_input` and `waiting_approval`,
  both labelled **`Needs your reply`**. Every other state renders nothing —
  finished work needs no badge, and `running` is visible from ordering.
- **Never** render `You:` / `Assistant:` prefixes, model names, or response
  previews on this row.

Use `listRecentRuns(workspaceId, 10)` from `src/domains/agents/queries.ts`. It
already selects exactly `id, state, objective, model, summary, error, createdAt`
and orders by `createdAt desc`.

### The composer island

`new-conversation.tsx` is the one client component on the page. It must reuse
the existing run-start path, not invent one:

- Call `startChatRun` from `src/app/(workspace)/apps/alfred/chat-actions.ts`
  with `subject: { type: "artifact", id: "" }`.
  **Verify first** that `engine.start` accepts an empty subject id — `subjects`
  is `jsonb not null default []`, so an empty array is the honest value. If an
  empty id fails validation, pass `subjects: []` instead by adding an optional
  parameter to `startChatRun`. Record which you chose in the task report.
- On success, `router.push(`/alfred/${runId}`)` (Task 4's page).
- On failure, render the returned message as a `role="status"` line beneath the
  composer. Do not throw, and do not clear the draft — losing typed text on a
  failed send is the worst failure here.
- Enter submits, Shift+Enter inserts a newline. The textarea autofocuses.
- Idempotency: `startChatRun` takes no key and says so in its comment. Generate
  one `crypto.randomUUID()` per submit attempt inside the island and guard with
  a `pending` flag; do not disable the button without also clearing the flag in
  a `finally`.

### Acceptance

```sh
pnpm typecheck
pnpm lint
```

Manual, in the browser (`pnpm dev`, headless):
- `/alfred` with zero runs shows greeting + composer and nothing else.
- Typing and pressing Enter creates a run and navigates.
- `/alfred` with runs shows `Recent` and one row per run; only waiting runs
  carry `Needs your reply`.

### Do not

- Keep `EmptyState` for "No threads yet" or "No runs yet".
- Keep the "Threads" section, its copy, or its box.
- Render `Citations`, `DraftControls`, or `RunControls` on this page.

---

## Task 3 — Retire what this screen no longer owns

**Files:** `src/app/(workspace)/alfred/page.tsx` (already rewritten in Task 2),
`src/app/(workspace)/alfred/start-run-form.tsx`,
`src/app/(workspace)/alfred/draft-controls.tsx`,
`src/app/(workspace)/alfred/run-controls.tsx`,
`src/app/(workspace)/alfred/dossier-form`-style panels if unused,
`src/domains/agents/queries.ts` (only if a query loses its last caller).

After Task 2 the page no longer mounts `RunControls`, `DraftControls`,
`Citations`, `StartRunForm`, `ListToolbar`, `Pagination`, `NoResults`,
`Section`, `PageHeader`, or `EmptyState`.

For each of those **components in `alfred/`**:

- If nothing else imports it, delete the file.
- If something else imports it, leave it and note the importer in the report.

Grep first, do not assume. `Section`, `PageHeader`, `EmptyState`, `ListToolbar`,
`Pagination`, and `NoResults` are shared and stay.

`listDocumentSearchResults` and `draftsForRuns` in the page are unmounted with
the page rewrite; **do not delete the domain functions** — `dossiers` and
`notebook` surfaces use that shape. Task 4 reintroduces citations on the run
detail page.

### Acceptance

```sh
pnpm typecheck && pnpm lint && pnpm test
```

`pnpm test` green proves no unit test referenced a deleted component.

### Do not

- Delete anything under `src/domains/`.
- Touch `src/components/page-header.tsx` or other shared components.

---

## Task 4 — The conversation page, with a Details disclosure

**Files:** new `src/app/(workspace)/alfred/[runId]/page.tsx`; new
`src/app/(workspace)/alfred/[runId]/details.tsx` (server component, no client
needed); reuse `src/app/(workspace)/alfred/run-controls.tsx` and
`draft-controls.tsx` (do not delete them in Task 3 if this task needs them —
Task 3's rule is "delete only if unimported", so keep the ones this task keeps).

### Layout

```
← Recent

Design the provider gateway                     [Needs your reply]

  You
  Redesign the provider tools around typed calls.

  Polymath
  Here is what I found …

  ─────────────────────────────────────────────
  > Details
      Model        gemini-3.5-flash-lite
      Tools        documents_search, tasks_read
      Budget       $0.50 estimated · $0.12 used
      3 sources read
      Run timeline (7 events)
      [Stop] [Save as draft]
```

- Transcript from `listThreads(workspaceId, [runId])`, rendering user and
  assistant entries with `Markdown` for assistant text (as the old page did).
- `Details` is a native `<details>`, closed by default. It holds everything the
  brief moved off the home screen: model, tools, budget, citations, the run
  timeline, and the run/draft controls.
- **Approvals are not here.** A waiting run shows `Needs your reply` and links
  to `/reviews`.
- A run in another workspace or a missing run: `notFound()` — same 404 for both,
  matching `src/app/api/v1/runs/[runId]/route.ts`.

### Notes

- Use `getRun(auth.workspaceId, runId)` from `src/domains/agents/queries.ts`;
  it already returns null for both cases.
- Budget: `spendingReservations` + `spendSettlements` in
  `src/domains/spending/`; if a per-run spend query does not exist, render only
  the estimate and note the gap in the report rather than writing a new query
  beyond the task.
- Keep this a server component. The only client island is `RunControls`.

### Acceptance

```sh
pnpm typecheck
```

Headless browser check:
- `/alfred/<id>` renders the transcript and a closed `Details`.
- `Details` expands to model, tools, sources, and timeline.
- `/alfred/<random-uuid>` returns 404.
- A run from another workspace returns 404.

---

## Task 5 — Verification and copy audit

**Files:** `tests/e2e/smoke.spec.ts` (already partly updated in Task 1),
plus a new assertion block; no source changes expected.

### What to check

1. **Forbidden strings are gone from `/alfred`.** Grep the rendered page (or
   assert in Playwright) for: `Hand off work and inspect what it did`,
   `Start a run`, `No threads yet`, `Recent runs`, `You:`, `Assistant:`.
2. **The rail order** is Assistant then Today.
3. **The placeholder** is exactly `Ask anything or describe a task…`.
4. **One status only.** Seed or stub a run in `waiting_approval` and assert the
   row shows `Needs your reply` and does not also show `running` or `In progress`.
5. **`skills`/design review.** Run `/design-review` against the new screen and
   fix anything it flags that is a real inconsistency (not a new feature).

### Acceptance

```sh
pnpm check
pnpm e2e
```

Both green. The e2e suite includes the updated home assertion from Task 1.

---

## Out of scope

- Suggestion chips.
- Inline approvals on the conversation page.
- Changes to `/reviews`, `/command-center/briefing`, or the Conversations
  screen.
- Renaming `/alfred` or introducing a `/assistant` URL.
- The provider gateway work in
  `docs/superpowers/specs/2026-10-20-agent-provider-gateway-design.md`. This
  plan is the UI half only.
