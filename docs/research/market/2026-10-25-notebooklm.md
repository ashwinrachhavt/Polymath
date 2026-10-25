# Market research: NotebookLM (Google)

**Date:** 2026-10-25 · **Analyst:** overnight build session · **Status:** current as of March 2026 sources
**Why this one first:** Axiom explicitly parity-tracks NotebookLM (`docs/plans/2026-10-19-notebooklm-parity-plan.md`).

## What it is

Google's source-grounded study workspace: you load sources into a notebook, and
Gemini answers, summarizes, and generates derivative artifacts *only from those
sources*, with citations. Single-player by default; notebooks can be shared.
It is the category leader for "grounded AI over my documents" and the bar for
Axiom's knowledge surface.

## Current feature set (verified 2026-10-25)

- **Grounded chat with citations** over the notebook's sources; conversation
  history is now saved, resumable, and private to the user even in shared
  notebooks (deletable at any time). [S1]
- **Artifact creation from chat**: ask in chat and get an Audio Overview, Video
  Overview, report, etc. without leaving the conversation. [S1]
- **Audio Overviews** (the breakout feature; podcast-style two-host summaries),
  interactive mode, more languages, longer content. [S3]
- **Video Overviews**, upgraded March 2026 to **Cinematic Video Overviews**:
  Gemini 3 acts as "creative director" (narrative, visual style, format,
  self-review), with Nano Banana Pro and Veo 3 rendering. English only. [S2]
- **Slide decks with revisions**: per-slide stylistic or factual feedback,
  regenerated as a new deck; export to PPTX as well as PDF. [S1]
- **Infographics**: auto-selected style, or manual pick from ten predefined
  styles (Sketch Note, Kawaii, Professional, Scientific, Anime, Clay,
  Editorial, Instructional, Bento Grid, Bricks). [S1]
- **Flashcards & quizzes** with progress saved across sessions, "Got it" /
  "Missed it" marking, shuffle, a results screen, and per-card deletion. [S1]
- **Sources**: PDF, Google Docs/Slides, URLs, YouTube, pasted text, audio;
  **EPUB added** March 2026. [S1]
- Mobile apps (iOS/Android) with feature parity for the study tools. [S3]

## Business model

Free tier for all consumer Google accounts and Workspace customers. The
frontier features gate on paid tiers: Cinematic Video Overviews require Google
AI Ultra (consumer) or Workspace Business Standard/Plus and above. [S1][S2]
The real moat is not price; it is Gemini/Veo model access and zero setup.

## Strengths

- Artifact generation breadth (audio/video/slides/infographics/quizzes) that no
  indie competitor matches; each artifact type is one click from the sources.
- Grounding discipline: answers cite passages from the user's own sources.
- Zero-friction onboarding for anyone with a Google account.

## Weaknesses (relative to Axiom's thesis)

- **Notebook silos**: knowledge lives per-notebook; nothing links across
  notebooks, and nothing persists as a durable, queryable personal graph.
- **Study-only**: the loop ends at "understand the material". No tasks, no
  follow-ups, no CRM, no calendar - insight never becomes action.
- **Generation without verification**: artifacts are model-written prose; the
  user trusts fluency. There is no mechanism that proves a claim against the
  source text before it is saved.
- **One vendor's models**, no cost transparency, no local story.

## What Axiom can assimilate

1. **Saved, private, resumable grounded chat.** NotebookLM just made this
   table stakes. Axiom's chat surfaces should persist conversations as
   first-class rows (the `conversations` domain) so a research thread survives
   sessions. Small, additive.
2. **Artifact-from-chat.** "Turn this conversation into a report/deck" maps
   onto the Studio generation seam (`src/domains/knowledge/studio.ts`) - the
   agent run already produces draft artifacts pinned to a dossier.
3. **Flashcards/quizzes from zettels, with progress.** The learning tables
   exist but are dead code (parity plan, 2026-10-19). Zettels with verified
   claims are a *better* quiz source than NotebookLM's raw sources, because
   each question can cite a claim that survived quote verification.
4. **Slide-deck revision loop.** Accept per-slide feedback and regenerate -
   the Studio draft + retry pattern already generalizes.
5. **EPUB ingestion** via the extraction seam, if long-form book reading is a
   target flow (reading domain exists as of #293).

## Where Axiom can differentiate

1. **Verified claims, not fluent prose.** The zettel pipeline re-locates every
   quoted claim in the source text and drops what does not verify (#293).
   NotebookLM has no equivalent; "an AI that shows its receipts" is the trust
   story.
2. **One graph, not silos.** Zettels, concepts, and evidence link across
   everything the user has ever captured; NotebookLM cannot answer "what do I
   already know about X" across notebooks. Axiom's hybrid RRF retrieval with
   citations (verified for ASH-274) already does this.
3. **Knowledge becomes action.** Captures classify into task/contact/note
   proposals (ASH-272), accepted proposals become tasks (ASH-278), the daybook
   plans the day. NotebookLM stops at study; Axiom closes the loop.
4. **Open questions as first-class output.** The reading summarizer emits
   *unresolved questions* alongside claims (#293) - tracking what you don't
   know yet is a research tool, not a study tool.
5. **Provider freedom + cost honesty.** The registry/quota-ledger posture
   (free-first, hard stops, no silent paid fallback) vs. one vendor's meter.

## Sources

- [S1] Google Workspace Updates, 2026-03-20: "New ways to customize and
  interact with your content in NotebookLM" -
  https://workspaceupdates.googleblog.com/2026/03/new-ways-to-customize-and-interact-with-your-content-in-NotebookLM.html
- [S2] Google blog, 2026-03-04: "Generate your own Cinematic Video Overviews
  in NotebookLM" -
  https://blog.google/innovation-and-ai/products/notebooklm/generate-your-own-cinematic-video-overviews-in-notebooklm/
- [S3] Google blog, 2026-01: NotebookLM app + Video Overviews rollout -
  https://9to5google.com/2026/01/29/notebooklm-app-video-overviews/
- Internal: `docs/plans/2026-10-19-notebooklm-parity-plan.md` (premise table
  with code receipts)
