# Flagship journey audit - current versus needed (ASH-201, stage 1)

Date: 2026-10-21. Scope: stage 1 of the ASH-201 delivery sequence - the
current-versus-needed map, written against `main` (396a0a5), every claim with
a path. This document changes nothing. The product-contract wording stays a
decision for Ashwin; the gaps named here are candidates for that wording and
for the owning tickets (ASH-188, ASH-199, ASH-200), not new work packages.

Journey: source material -> editable, cited output -> reviewed next actions
-> return and continue. Scenario: an engineer compares two architecture
approaches.

## Stage map

| Stage | What exists on main (verified) | What is missing (named gap) |
| --- | --- | --- |
| Start - "help me decide between these approaches" | The Assistant is home: one composer plus recent conversations; a fresh workspace shows a greeting and the composer (`src/app/(workspace)/alfred/page.tsx:23-30`) | No "what are you trying to finish?" first visit, no entry points (bring a document / research a question / continue work), no continue rows (design rule 5) |
| Bring context - add a proposal, articles, existing notes | Capture to inbox; URL capture; document upload into the library; dossiers are source-bounded workspaces with attachable documents (`src/domains/knowledge/dossiers.ts:149`) | Material does not attach to a conversation or a decision; a dossier is the only grouping, and it is a destination, not a work context (design rule 1) |
| Prepare - show what material will be used | Source-version-pinned context manifests exist in the agent runtime (`src/domains/agents/schema.ts`, ASH-118) | No person-facing context contract before a run: selected vs retrieved vs excluded vs unavailable is not shown (design rule 3; owned by ASH-188's plan addendum) |
| Produce - editable result with evidence and uncertainty | Runs produce output; "Save as draft" creates an artifact; Keep (reviewed) / Discard (archived) is explicit; a draft never publishes itself (`src/app/(workspace)/alfred/draft-controls.tsx`); the notes editor is Tiptap (`src/components/products/alfred/rich-editor.tsx`) | Later AI changes do not arrive as a proposed revision against the edited artifact; the save-state and stable-link contract (design rule 2) is only partially visible in the UI |
| Decide - correct an assumption, choose a direction | Human edits are plain edits in the editor; reviewed AI drafts exist for the notebook (staged as reviewable drafts, #58) | Accept/reject review of AI edits on artifacts is not built (ASH-203 KNOW table, "Partial"); nothing separates the person's judgment from the AI draft on one record |
| Follow through - accept proposed tasks | Document obligations become reviewable tasks through one domain command (`src/domains/work/commands.ts:16-38`); Calendar Assist proposals approve with one tap (#146) | Proposed follow-ups from an assistant run do not land as task proposals linked back to the decision and its material |
| Leave - close the app | Outputs, drafts, tasks and sessions are durable Postgres records; focus sessions resume after refresh, navigation or another tab (`src/app/(workspace)/neuralflow/focus/page.tsx:15`) | Nothing records "what happens next" for a piece of work that has no open session |
| Return - open the work again | Conversation history and drafts persist; a running focus session resumes | No Continue: no surface derives current output, last meaningful change, next step or unresolved question from saved state (design rule 4). ASH-199 WP11 owns the Today surface for this and is gated on route-map approval |

## What the audit says about the journey claim

Stages Leave and Return are the proof, and they are the two weakest stages:
persistence exists everywhere, continuation exists nowhere. Every other stage
has a credible merged starting point; none of them meets the brief's full
contract yet (context visibility, protected edits, proposed follow-ups).

## Reuse before build (per design rule 1)

The gaps do not obviously need new tables. Dossiers already group material;
artifacts already hold outputs with a review state; the obligations path
already turns a reviewed item into a canonical task; the activity and audit
tables already record what happened. A minimal "current output + next step"
on existing records, plus a derived-continue query over state and activity,
covers most of Continue. The one structural question - whether Pursuit is a
new record or a view over existing links - is open decision 1 in ASH-203 and
stays open here.

## Exit-condition check (stage 1)

The journey, without implementation subsystems: a person brings material to
a question, gets an answer they can edit and trust because it shows its
sources, turns the answer into a decision and a next step they chose, leaves,
and returns to find the work as they left it - what was decided, what is
still open, and what happens next. That sentence names no subsystem; stage 1
can exit once Ashwin approves the product-contract wording it implies.
