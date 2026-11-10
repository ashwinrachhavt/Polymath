# Polymath consolidation — design

Date: 2026-11-10 · Owner: Ashwin · Status: draft for owner review

## Why

On 2026-11-09 the owner booted main after merging #556–#558 and found the app unintuitive: it "is not telling a product story". Notes had four views (list, editor, stacked reader, board) and a second sidebar. Quizzes and flashcards were two levels deep inside a project. Retired routes were still linked. An expired session made pages flicker endlessly. The sidebar lists 22 destinations from three merged apps.

## The story

**Polymath is a build-it-yourself Duolingo for knowledge work.** In a world where AI can do the work, people still have to understand it. People are busy, distracted and need a reason to come back. Polymath keeps the human in the loop:

1. **Bring it in.** Sources go into a Notebook (NotebookLM-like).
2. **Get taught.** The AI probes what you know, plans a path and teaches one step at a time.
3. **Practice.** Quizzes, flashcards and Explain It, generous and adaptive.
4. **Keep it.** What you understood becomes notes linked into your idea map.

An incentive layer (Up next, streaks, stones for demonstrated understanding) brings you back.

Every change in this spec must serve one of the four steps or the incentive layer.

## Design principles

- **Apple minimalism.** Three nouns: **Notebook** (a subject you are learning), **Source** (what you brought in), **Note** (what you understood). No modes. One primary action per screen. Progressive disclosure: the default path needs no choices, and options sit one layer down.
- **Behavioral design.** Home is a trigger: "what's due now" with one Start button. Defaults keep effort low. Sessions last 3–5 minutes with a clear end. Progress is visible. Stones reward demonstrated understanding only (the 2/3 gate stays). No streak shaming.

## Scope

### 1. Notes: one view, a Notion page with margin notes

- **Single note.** A Notion-like page: a title, a small properties block (tags, notebook), a body you can always type into, and comments at the end. No Read/Edit toggle. No in-page notes list (the second sidebar). A ⌘K note switcher finds and creates notes.
- **Links.** A `[[link]]` renders as a link in the text. The linked note's title and first lines appear as a **margin note** beside the paragraph that cites it, in the style of numinous.productions/ttft. Clicking the link opens that note. Backlinks are listed at the end of the page.
- **Small screens.** Margin notes collapse to inline expandable notes below the paragraph.
- **Removed.** The stacked evergreen reader, the board (`?board=1`), the list view (`?mode=list`), the Read mode and the in-page list column, along with their code.
- **Kept.** Autosave, checkpoints and versions (in the "…" inspector), wiki-link sync, Tab autocomplete, slash commands, Ask AI and task checkboxes.
- **Redirects.** `/polymath/notes?id=…` opens that note. `/polymath/notes` opens the most recent note with content. `/polymath/notes/evergreen` and the retired query params redirect to `/polymath/notes`.
- **Ideas** (zettels) stays its own sidebar entry.

### 2. Navigation: grouped by job

| Today | After |
|---|---|
| Polymath home (runs), `/learn` | **Home = Up next**: one Continue card (flashcards due, quiz waiting, a lesson in progress), a streak, recent Notebooks |
| Overview, Focus, Work, Day, Shut down | **Today**: the plan, tasks and a focus timer on one screen; Shut down is the end-of-day step inside it |
| People, Companies | **People**: one entry with a Companies filter, presented as context about the people you import |
| Notebook (projects), Notes, Ideas, Document Vault, Artifacts, Inbox | Kept. The **Notebook** is the learning home. |

Supervision, Reviews, Activity, Spending and Settings stay where they are. Old routes redirect to their new homes. The sidebar order follows the loop: Home, Inbox, Notebooks, Notes, Ideas, Document Vault, Artifacts, Today, People, then the shared items.

### 3. Notebook is the learning home

- **Page order:** Sources (add files, links, Vault documents) → **Learn this** → results → Runs. Company research moves into the "…" menu.
- **Learn this** opens a sheet: Quiz, Flashcards or Explain It. It defaults to all ready sources. Results open in place as cards, not as a run to go and find.
- **Counts.** Flashcards and quizzes default to **20–50 items**: the model picks a count in that range from the amount of source material, and the user can set an exact number from 5 to 100 one layer down. Explain It and future generators expose the same "how much" control. Generation over 20 items runs in batches, so the first cards appear quickly.
- The project page leads with **Open Notebook** (shipped in #560).

### 4. Inbox: know what a capture is

- **Jev classification.** Every capture is labeled with its kind (article, idea, task, person, reference, quote, other) and a short reason. The rules classifier decides first and Jev settles the rest. This is already wired in `src/domains/capture/enrichment-handler.ts` and `src/domains/knowledge/jev-classify.ts`, using `TYPESAFE_API_KEY` and a monthly budget of 10M input tokens (`JEV_MONTHLY_INPUT_TOKENS`). Work: verify it runs end to end, show the label on each Inbox row and in the detail panel, let the user correct it (the correction is stored), and show an honest state when the budget is spent.
- **Enrich (opt-in, per capture).** An **Enrich** action on a link or page capture runs Firecrawl to fetch the page, then the generation provider writes a summary, key points and suggested Notebook. Nothing is fetched without the click. Failures show a retry. The result is stored with the capture and carries into the Notebook when the capture is filed.

### 5. Focus pages: the sidebar disappears

- **Focus pages:** the note page, learning sessions (quiz, flashcards, Explain It, later teaching), chat and agent conversations, and reading a source.
- **Behavior:** the app sidebar is hidden and the page uses the full width. Moving the cursor to the left edge (a hover zone about 12px wide) slides the sidebar in as an overlay, and it hides when the cursor leaves. A top-left toggle and the `[` shortcut pin it open. The pinned state persists per user (localStorage).
- **Mechanism:** one shell-level mechanism that each page opts into with a single flag in its layout or route metadata. No per-page sidebar code.
- **Not focus pages:** list and overview pages (Home, Inbox, the Notebook list, People, Today), which keep the fixed sidebar.

### 6. Reliability (in progress in PR #560)

- An expired or invalid session lands once on sign-in, keeping `returnTo`, and stops. It never loops or flickers.
- Polling hooks (for example `/api/v1/focus/live`) stop or back off on authentication failure.
- One render per action. Already done in #560: autosave no longer revalidates, and redundant `router.refresh()` calls were removed.

### 7. Removal audit

Delete what does not serve the loop. Linear-issue drafting is already removed (#560). Before deleting anything else, list each candidate (retired routes, dead links, unreachable features, duplicate screens) in a short table in the implementation plan, and get the owner's yes or no. Nothing is deleted silently. Database migrations and stored rows are never dropped: old data must stay readable.

## Out of scope (separate spec, next)

- **The teaching session**: probe → plan → teach → practice, with "think out loud" fields and a persistent graph of propositions, modeled on amosblomqvist/learnharness. It builds on the Notebook learning home and the notes/idea map from this spec.

## Build order

Each step is one PR, verified before the next starts.

1. Reliability fixes (finish #560).
2. Focus-page sidebar (the shell mechanism), because notes and learning pages build on it.
3. Notes as a single page with margin notes, plus removal of the old views.
4. Notebook learning home: Learn this, counts and in-place results.
5. Navigation: Home = Up next, Today, People, redirects.
6. Inbox: Jev labels and corrections, opt-in Enrich.
7. Removal audit, then deletions the owner approved.

## Verification

Each step must pass tsc, lint, knip, the unit suite and the inventory check, plus a headless Playwright journey and screenshots for the screens it touches. The end-to-end acceptance journey:

1. Port one chapter of the owner's intangible.ai curriculum (a Markdown or docx file) into a Notebook.
2. Run Learn this to get 20+ flashcards and a quiz.
3. Answer them, see Up next and the streak update on Home.
4. Write a note that links two ideas, and see the margin note.

The whole journey must work with no flicker and no reloads, and an expired session must go to sign-in.

## Open questions

- **Margin notes:** should they show the linked note's first paragraph (proposed) or its whole body, scrollable?
- **Today:** merge as one screen with three sections (proposed), or tabs?
