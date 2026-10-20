# Inbox redesign + extraction cleanup — design doc

Date: 2026-10-20. Branch: `ashwinr/inbox-enrich`. Status: reviewed; D1–D4 resolved.

One PR (D4: owner chose to keep both workstreams together, accepting coupled
rollback): (1) the Inbox becomes a manageable two-pane queue
inspired by the shadcn/studio inbox-app block, (2) the extraction path gains
rules around docling and one shared cleanup pass.

## Problem

**Inbox.** `/command-center/inbox` renders every capture's full text inline
(`inbox-list.tsx:73` — `whitespace-pre-wrap` on the raw body). One long capture
pushes everything below it off-screen; the queue is unreadable at 15 items, let
alone 50. The capture form occupies prime space above the list. There is no
detail view, so actions sit under every row. The screenshot of a pasted Mistral
7B article is the failure mode: one capture is a page of text.

**Extraction.** `docling-docker.ts:51-59` accepts an empty `md_content` as
`ok: true` with `text: ""` — a silent empty success. Extracted text (markdown
from docling, page-joined text from pdf-text-layer, plain text) is stored
verbatim: runs of blank lines, control characters, and per-line trailing
whitespace pass straight into embeddings and the library.

## Goals

- Inbox answers "what is here, what needs deciding" on one screen without scrolling.
- Bulk archive/restore, because §6.2 says thirty items take one action.
- Zero silent empty extractions; one cleanup seam for all extractors.
- No new tables, no second capture store, no client data layer.

## Non-goals (NOT in scope)

- Classification proposals (`captureProposals` table exists but has no writer
  or reader today). Bulk accept for high-confidence proposals arrives with the
  classifier, not this PR. Bulk operations here are user-directed (archive/restore).
- Non-goals corrections (D11, D12): mobile behaviour and accessibility are
  now specified inside Part 1 below; they were gaps, not exclusions.

- Re-running cleanup over already-stored extraction text stays out of scope:
  cleanup applies at the extraction boundary from this PR forward.

## Part 0 — Provider workstream (D13)

The owner provisioned `LLAMAPARSE_API_KEY` and `REDUCTO_API_KEY` and asked
that both be verified working.

- **Reducto adapter.** New `src/integrations/extraction/reducto.ts`
  implementing the existing `ExtractionProvider` contract, resolved in
  `extractionProvider()` when `REDUCTO_API_KEY` is set — priority after
  docling, before LlamaParse (free/local first, hosted fallback). Cleanup
  seam applies (plain or markdown per its output). Sanitized-fixture
  contract test in CI; never live calls in CI (coding.md).
- **Live smoke script (local only).** `scripts/smoke/extraction-providers.ts`:
  runs one real PDF through every configured provider (docling if
  `DOCLING_SERVE_URL`, Reducto, LlamaParse), prints extractor id, page
  count, char count, and the first 200 chars of cleaned text. Never part of
  `pnpm check`. This is the honest answer to "do the keys work".
- **`pnpm check` stays fixture-only.**

## Part 1 — Inbox two-pane

### Layout

```
app rail | list pane (fixed ~420px)        | detail pane (flex-1)
         | composer (collapsed, 1 line)    | title, state, kind, time
         | filter tabs + counts            | full text (scrollable, clamped line-height)
         | row: state · kind · time        | actions: Make task / Archive / Restore
         |      preview (3 lines clamped)  | open-in-Work link when converted
         | pagination (button, not links)  | empty state: "Select a capture"
```

- **URL is the state.** `?id=<captureId>` selects a row; the detail pane is
  server-rendered in the same RSC pass. Back/forward and refresh work; no
  client store. This is the product's "one record, many views": the detail pane
  is a view of the same `captures` row.
- **Row content:** processing-state chip (existing `Status` tone mapping),
  kind, relative time, 3-line clamped preview (`line-clamp-3`) over the
  300-char preview slice. Full text lives in the detail pane only.
- **Composer collapses.** One input line ("Capture a thought, excerpt, or
  URL…"); expands to the existing textarea on focus. Same
  `captureTextAction`. It sits at the top of the list pane, not a modal
  (spec §6.1: not a modal, not a form — inline and instant). After a
  successful capture the textarea clears and the page navigates to
  `?id=<new capture>` so the detail pane shows what was just captured
  (D8) — the immediate "did that work" confirmation.
- **Filter tabs carry counts** (To clarify / Converted / Archived / All),
  rendered as the existing filter links plus `countToClarifyForPage`.
- **Bulk select.** Checkbox per row; a list-pane sticky bar (D6) with
  Archive / Restore / Clear. Each selected capture fires the existing
  version-checked `setCaptureStateAction` inside one client transition (D2:
  per-row loop — no batch endpoint; partial failures are per-row visible).
- **Detail actions reuse** `makeTaskAction` / `setCaptureStateAction` with the
  row's `version`. **Action wording is state-exact (D15, product.md
  vocabulary):** an open row shows "Archive" (→ discarded); a discarded row
  shows "Restore capture" (→ unprocessed); a converted row shows no state
  action — it is already a task, with the "Open task in Work" link only. The
  bulk bar offers the same two verbs; rows whose state does not permit the
  transition report per-row errors via the domain guard. Optimistic updates: the existing list reducer
  (`inbox-list.tsx:39-43`) handles per-row and bulk state changes in the list
  (row leaves the filtered view, state updates in All); the detail pane's
  actions island holds its own small optimistic state. Two reducers, both
  `useOptimistic`, over the same decision shape.
- **Selection rules.** `?id=` may reference a capture outside the current
  filter: the detail pane still renders it (it is a view of the record, not of
  the view); the list shows no highlighted row. Checkbox clicks stop
  propagation — they never trigger row navigation. Bulk actions act only on
  rows whose state permits the transition; `setCaptureState`'s domain guard
  rejects others and the error surfaces per row.
- **URL-only captures in the detail pane (D14):** the URL is the content. It
  renders as a link in `.readout` style at the top; fetched page text renders
  below when the capture carries it. Never an empty text node (§10: no empty
  pretending success).
- **Pagination (D5: page-based).** Prev/Next under the list pane with a
  "Page 2 of 4" mono `.readout`. `?id=` persists across pages: paging away
  keeps the detail pane showing the selected row even when it is not on the
  new page; the list shows no highlight then.
- **Bulk bar (D6: list-pane sticky).** While rows are selected, a sticky bar
  at the bottom of the list pane only: "N selected" mono readout, Archive,
  Restore, Clear. The detail pane stays untouched and readable during
  selection.
- **Empty states** per spec §6.2: filtered-empty and zero states distinct
  ("Nothing in this view" vs "The inbox is clear").

### Files

| File | Change |
|---|---|
| `src/domains/capture/queries.ts` | `searchCaptures` selects a 300-char preview slice instead of full text (D3); new group-by read for the four filter-tab counts |
| `src/app/(workspace)/command-center/inbox/page.tsx` | two-pane composition, `?id=` resolution, detail fetch |
| `(workspace)/command-center/inbox/inbox-list.tsx` | rows → clamped previews, bulk select, action bar |
| `(workspace)/command-center/inbox/inbox-detail.tsx` | new: server-rendered detail + client actions island |
| `(workspace)/command-center/inbox/inbox-client.tsx` | composer collapse; detail actions island |
| `(workspace)/command-center/inbox/data.ts` | add `getCaptureForPage` (cached, `AuthContext`-workspace-scoped); cached wrapper for the tab-count read |
| `(workspace)/command-center/inbox/actions.ts` | unchanged — bulk bar loops `setCaptureStateAction` client-side (D2) |

### Design language

Warm bone ground, hairline separators, no zebra, no shadows (DESIGN.md §4;
taste app-screens rules: colour on data not chrome, flat surfaces, honest
states). Selected row = `--muted` ground, not an accent pill.

**Kit and tokens (DESIGN.md §6, §9):**
- State chips: the existing `Status` component, full radius (the standing
  chip case per §6), word always present (§4.3 — never colour alone), 24px
  minimum target.
- Panes: separated by 1px hairline `--border`, not `Panel` boxes — the layout
  is the §8 inspector pattern with the *list* as the fixed pane. No shadows.
- Empty states: `Empty` / `.panel-empty` — dashed, quieter, an invitation.
- Actions: existing `Button` variants (primary charcoal "Make task", ghost
  "Archive"). Press feedback `scale(0.98)`.
- Timestamps, counts, pagination readout: `.readout` mono with tabular
  figures (§5 — numbers are never the sans face).
- Spacing on the 4px rhythm (§6: gaps 4/8/12/16/24/32); list rows 8-12px
  vertical; panel padding 16-24px.
- Bulk bar: 8px `--radius` (radius ladder, not full), hairline border,
  `--card` fill, shadow allowed (it genuinely floats over list content,
  `--shadow` warm-tinted per §6).
- No raw hex, no Tailwind palette classes (§13 rule 3). No em dash anywhere
  (§11, §13 rule 7).

### Responsive (DESIGN.md §8 — declared in the inbox page component, D11)

- Below 1024px: the detail pane stacks under the list pane (not hidden);
  selecting a row scrolls to it. The list pane loses its fixed width and
  becomes full-width.
- Below 640px: the bulk bar becomes a full-width fixed bottom bar (it must
  stay reachable while scrolled); the composer stays one line; touch targets
  on rows and checkboxes rise to 44px.
- Above 1024px: the two-pane layout with the 420px list pane.

### Accessibility (DESIGN.md §12 — WCAG 2.2 AA floor, D12)

- Rows are plain links (anchor navigation to `?id=`); keyboard Enter opens,
  Tab reaches them in DOM order. Arrow-key roving is a later enhancement,
  not in this PR.
- Checkboxes carry `aria-label` naming the capture ("Select capture: <title>").
- The bulk bar is a `toolbar` landmark; results announce via
  `aria-live="polite"` (one summary line: "3 archived, 1 failed"), never a
  per-row announcement stream.
- On selection change, focus moves to the detail pane's heading (it is a
  heading element, not a div). Focus returns to the originating row link when
  selection is cleared.
- `:focus-visible` comes from the global rule — no component-local overrides.
- Contrast: chip word against its pastel ground, placeholder/helper/error
  text against the section, focus ring against everything — checked before
  ship (§12 makes the check mandatory).

### Interaction states (DESIGN.md §10 — designed, not defaulted)

```
FEATURE              | LOADING             | EMPTY                    | ERROR                     | SUCCESS              | PARTIAL
---------------------|---------------------|--------------------------|---------------------------|----------------------|--------
List pane            | skeleton rows       | "The inbox is clear"     | labelled status card      | rows render          | n/a
                     | (shaped like rows)  | (+ composer invitation)  | (Unavailable component)   |                      |
Detail pane          | skeleton, same      | "Select a capture"       | labelled status card      | full text renders    | n/a
                     | shape, not spinner  | (panel-empty invitation) |                           |                      |
Composer             | button "Capturing…" | n/a                      | inline error below input  | textarea cleared,    | n/a
                     | disabled            |                          | (never placeholder-as-    | row appears at top   |
                     |                     |                          | label)                    |                      |
Bulk bar             | buttons disabled    | n/a                      | per-row error list in     | selection cleared,   | rows that
                     | during transition   |                          | the bar, one line each    | rows leave the view  | failed stay
Tab counts           | "—" placeholder     | zeros print as zeros     | n/a                       | counts render mono   | n/a
```

Loading uses skeletons shaped like the final content (§10), never a spinner.
Tab counts use the tolerant Date|string formatter at the render seam (learning
`drizzle-aggregate-date-string`: aggregates cross the boundary as strings).

### Motion (DESIGN.md §7)

150ms ease-out, transform and opacity only, interaction feedback only:
row hover = muted fill fade; composer expand = opacity 0→1 with the field
growing one line (the height change is one layout property, allowed here as
the interaction itself); bulk bar slides up 8px on appear; buttons press =
`scale(0.98)`. Nothing else animates. No entrances, no per-section fades. All
transitions honour `prefers-reduced-motion`.

## Part 2 — Extraction cleanup + docling rules

### Cleanup seam

New `src/integrations/extraction/cleanup.ts` — one pure function:

```ts
export function normalizeExtractedText(
  text: string,
  format: "markdown" | "plain",
): string
```

Rules, both formats: strip control characters except `\n` and `\t`; trim
trailing whitespace per line; collapse 3+ consecutive blank lines to one.
Markdown additionally: drop a leading/trailing page-marker artifact line if the
whole line is one of docling's `- <number> -` forms. No content rewriting, no
de-hyphenation (lossy), no HTML stripping (extractors already return text).

**Ordering matters (outside-review finding 1):** `pdf-text-layer.ts:34-37` and
`llamaparse.ts:116-120` compute per-page spans as offsets accumulated over the
joined text. Cleanup runs **before** span computation in those adapters — on
each page's text before it is joined — so the stored spans stay correct for
`proposeFromText` (extraction.ts:365) and evidence rendering. In docling (which
returns one whole-document markdown string and a single span) cleanup runs
before the span is built. Never clean after spans exist.

Applied inside each adapter before it returns, so `documentExtractions.text`
is clean at rest for every producer (docling, llamaparse, pdf-text-layer,
plain-text) with no second pass in the domain.

### Docling rules

1. **Empty is failure.** `docling-docker.ts` returns
   `{ ok: false, error: "docling-serve returned no readable text" }` when
   `md_content`/`text_content` is empty or whitespace — never `ok: true, text: ""`.
2. **Size guard (defense-in-depth).** Uploads and URL fetches already enforce
   `MAX_UPLOAD_BYTES` (`files/route.ts:57`, `capture-url.ts:158`), so no
   current path reaches the adapter oversized. The adapter still rejects
   inputs over the limit with a named error before the fetch, so a future
   caller cannot bypass intake's guard silently.
3. **Timeout stays 120s**; unreachable stays a named failure (already correct).
4. **Compliance note stays**: docling is local-dev only; production resolves
   LlamaParse or the pdf-text-layer floor.

### Files

| File | Change |
|---|---|
| `src/integrations/extraction/cleanup.ts` | new: `normalizeExtractedText` |
| `src/integrations/extraction/reducto.ts` | new: Reducto adapter (D13) |
| `src/domains/knowledge/extraction.ts` | `extractionProvider()` resolves Reducto when `REDUCTO_API_KEY` is set, after docling, before LlamaParse |
| `src/integrations/extraction/docling-docker.ts` | empty-text failure, size guard, apply cleanup |
| `src/integrations/extraction/llamaparse.ts` | apply cleanup (markdown) |
| `src/integrations/extraction/pdf-text-layer.ts` | apply cleanup (plain) |
| `src/integrations/extraction/plain-text.ts` | apply cleanup (plain) |
| `scripts/smoke/extraction-providers.ts` | new: local-only live smoke over configured providers (D13) |
| `tests/unit/extraction-cleanup.test.ts` | new: cleanup rules table-driven |
| `tests/integration/document-extraction.test.ts` | extend: empty docling result fails; Reducto sanitized-fixture contract test |

## Testing

- Unit (real Postgres not needed): cleanup rules as a table-driven test —
  control chars, blank-line collapse, per-line trim, markdown page markers, and
  a nothing-to-do pass-through.
- Integration: extraction stores cleaned text; a docling empty response is a
  failed extraction with the named error (fixture-level, no live docling in CI);
  Reducto adapter against a sanitized fixture (D13).
- Live smoke (D13, local only, never in CI): `scripts/smoke/extraction-providers.ts`
  over the configured providers with one real PDF — verifies the owner's new
  LlamaParse and Reducto keys end to end.
- E2E: extend `shared-command-layer.spec.ts` journey — capture → row appears
  clamped → open detail → Make task → converted state, plus bulk archive of
  two rows.
- Regression guard: existing `capture-inbox.test.ts` version-conflict tests
  must stay green (actions untouched in contract).

## Failure modes

| Failure | User sees | Covered by |
|---|---|---|
| docling down locally | named extraction failure, retry button | existing + empty-text rule test |
| oversized URL fetch | named failure before provider call | size-guard test |
| stale version on bulk op | per-row error in action bar | existing version tests pattern |
| empty filtered view | filtered-empty state | NoResults (exists) |

## Design Review Completion Summary

```
  +====================================================================+
  |         DESIGN PLAN REVIEW — COMPLETION SUMMARY                    |
  +====================================================================+
  | System Audit         | DESIGN.md present (full token system); UI   |
  |                      | scope: /command-center/inbox two-pane       |
  | Step 0               | 5/10 initial; gaps: states, responsive,     |
  |                      | a11y, tokens; focus: all 7 passes           |
  | Pass 1  (Info Arch)  | 6/10 → 9/10 (D5 pagination, D6 bulk bar)    |
  | Pass 2  (States)     | 4/10 → 9/10 (D7 state table)                |
  | Pass 3  (Journey)    | 7/10 → 10/10 (D8 post-capture selection)    |
  | Pass 4  (AI Slop)    | 8/10 → 10/10 (D9 motion spec)               |
  | Pass 5  (Design Sys) | 6/10 → 10/10 (D10 kit + tokens)             |
  | Pass 6  (Responsive) | 4/10 → 9/10 (D11 breakpoints, D12 a11y)     |
  | Pass 7  (Decisions)  | 3 resolved (D13 Reducto+smoke, D14 URL      |
  |                      | detail, D15 action wording), 0 deferred     |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (4 items)                           |
  | What already exists  | written                                     |
  | TODOS.md updates     | 1 item added (arrow-key roving, P3)         |
  | Approved Mockups     | 0 generated (no OpenAI key for designer)    |
  | Decisions made       | 11 added to plan (D5-D15)                   |
  | Decisions deferred   | 0                                           |
  | Overall design score | 5/10 → 9/10 (lowest pass: 9)                |
  +====================================================================+
```

Pass 6 at 9/10: arrow-key roving deferred to TODOS.md by explicit decision
(D12/TODOS). All other passes at 9-10. Mockups were not generated (designer
binary lacks an OpenAI key); token-level specs substitute.

## Design Implementation Tasks

Synthesized from this review's findings (design passes only; eng tasks T1-T5
from the eng review remain in force).

- [ ] **T6 (P2, human: ~2h / CC: ~20min)** — inbox — implement the interaction-state table: shaped skeletons, per-row bulk errors, tab-count placeholders
  - Surfaced by: Pass 2 — D7
  - Files: inbox page, inbox-list.tsx, inbox-detail.tsx, inbox-client.tsx
  - Verify: manual browser pass against the table in the plan
- [ ] **T7 (P2, human: ~1h / CC: ~10min)** — inbox — responsive collapse at 1024/640 per D11 (stack, full-width bulk bar, 44px targets)
  - Surfaced by: Pass 6 — D11
  - Files: inbox page component
  - Verify: resize pass at 1440/1024/640/375 widths
- [ ] **T8 (P2, human: ~2h / CC: ~20min)** — inbox — a11y: aria-labels, toolbar landmark, aria-live bulk summary, focus-on-heading selection
  - Surfaced by: Pass 6 — D12
  - Files: inbox-list.tsx, inbox-detail.tsx, inbox-client.tsx
  - Verify: axe scan + keyboard-only journey
- [ ] **T9 (P1, human: ~4h / CC: ~30min)** — extraction — Reducto adapter + provider priority + live smoke script (D13)
  - Surfaced by: Pass 7 — D13; owner provisioned REDUCTO_API_KEY
  - Files: src/integrations/extraction/reducto.ts, src/domains/knowledge/extraction.ts, scripts/smoke/extraction-providers.ts
  - Verify: run smoke script locally against LlamaParse + Reducto keys
- [ ] **T10 (P2, human: ~1h / CC: ~10min)** — inbox — detail pane URL-capture rendering + state-exact action wording (D14, D15)
  - Surfaced by: Pass 7 — D14, D15
  - Files: inbox-detail.tsx, inbox-client.tsx
  - Verify: manual pass over open/discarded/converted rows in All tab


## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | — | — | 0 | — | — |
| Outside Review | — | — | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | issues_open | 3 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | clean | score: 5/10 → 9/10, 11 decisions |
| DX Review | — | — | 0 | — | — |

**OUTSIDE COVERAGE:** design outside voices were not run — the design review proceeded directly after the eng review's outside-voice pass (codex quota exhausted; native fallback completed) on the same plan in the same session.
**VERDICT:** DESIGN CLEARED (9/10). Eng review required before ship (issues_open, mapped to T1-T10).
**UNRESOLVED DECISIONS:**
- none (D1-D15 all answered; arrow-key roving deferred to TODOS.md by explicit decision)
