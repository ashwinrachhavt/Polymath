# Polymath agent and learning change spec

## Goal (L1)

Deliver a source-grounded knowledge-work and learning assistant. One Polymath supervisor owns the conversation, answers simple requests directly, and delegates substantial work to durable, bounded Eve tasks. Captures remain raw and recoverable. Successful extraction can produce useful Zettels without unnecessary duplicates. Notebook becomes the project-scoped learning workspace, with one searchable Artifacts home for raw sources and derived materials.

Notebook learning capabilities:
- Create quizzes on demand from one or more pinned sources while preserving the current quiz interaction.
- Run a separate adaptive Explain It flow that judges answers against selected-source evidence, explains gaps, and flags ambiguity or conflict.
- Combine selected ideas into a new source-linked Zettel and reconstruct verified graph relationships from memory.
- Generate flashcards on demand and review them on a user-specific due schedule.
- Keep `/learn` as a cross-Notebook Up Next view rather than a second quiz authoring surface.

## Constraints and non-goals

- Save raw captures first. Run automatic Zettel generation only after successful extraction. Optional enrichment/crawl is a separate action and does not govern Zettel generation.
- Quizzes and flashcards are generated only on request. Wrong answers do not automatically create artifacts or review items.
- Zettel generation has no minimum. No-change is valid; repeat evidence links to the existing Zettel. New/revised ideas require a meaningful distinct insight, qualification, or disagreement.
- Check duplicates across the user's authorized knowledge. Use exact checks and vector-retrieved candidates first; use an LLM comparison only for ambiguous near matches.
- Internal artifacts may be saved after supervisor validation. External writes and consequential actions require approval.
- Do not create another source collection or duplicate artifact store. Keep raw sources and generated artifacts as distinct records with clear provenance.
- Preserve existing conversations, quizzes, attempts, source versions, and historical Superagent records during migration. Do not retire unrelated approvals, notifications, extraction, or connector effects.

## Approach (L2)

### Execution

Keep Eve as the model and tool runtime. Main chat starts an interactive Eve run through the existing `agents` engine. The engine owns the model loop and transcript. New chat requests no longer pass through Superagent admission and assessment. Keep Superagent for admitted tickets, their recovery workers, and the supervision UI until a call-site and retained-data audit proves those paths can retire. The `agents` runtime has callers across chat, Notebook, proposals, capture, and integrations, so remove only functions proven unused. Substantial background tasks still need bounded scopes, persisted events, cancellation, and recovery.

### Knowledge and capture

Keep raw capture before enrichment. Successful extraction starts a cost-bounded Zettel pass with a no-change outcome. Apply cheap same-source/exact-span checks before vector candidate retrieval; batch work where practical; ask a model to compare only ambiguous matches. Reuse existing ideas by attaching source evidence. Keep source claims, objective truth, learner understanding, and feedback as separate facts.

### Artifacts and Notebook

Make `/artifacts` the one searchable home over source documents and generated artifacts, with kind/status filters and direct source links. Keep source and generated records distinct; consolidate/redirect duplicate management surfaces without copying raw content. Reuse existing Notebook/Project source membership. Learning exercises run against the Notebook's pinned source versions.

### Learning records

Store helpful/not-helpful ratings once per user and artifact, with feedback tuning future generation only. Never edit existing artifacts from a rating. Persist multi-source quiz manifests containing immutable document/extraction versions. Every question's evidence identifies its source; verify quotes against that version. Keep the existing quiz row as the session and a pinned source manifest as its selected document/extraction snapshots. Keep question evidence source-tagged in its existing JSON record, so older quiz rows remain readable without backfill. Generate one bounded quiz call from all selected sources, then verify each quote against its tagged extraction. Make retries idempotent for the ordered source set and prompt version. Preserve existing per-document quizzes/attempts and reuse the current runner. Explain It evaluates free-response answers against source evidence and reports uncertainty/conflicts instead of asserting unsupported correctness. Flashcard content is shared; scheduling/recall is per user. React Flow reconstruct grades against verified typed relationships, while human graph edits remain separate.

### Compatibility and migration

Use additive migrations and preserve historical reads. Notebook owns quiz creation and all learning modes; `/learn` becomes a cross-Notebook queue over the same quiz/flashcard records. Keep all server actions authenticated and workspace/object scoped. Use stable identities for retryable generation and task scheduling.

## Implementation slices

1. Knowledge quality/capture: automatic Zettels only after successful extraction; no-change, global deduplication, source reuse, bounded cost.
2. Artifact and Notebook UX: one source/output gallery; multi-source quizzes in Notebook using the existing runner and history.
3. Learning modes: source-grounded Explain It, graph combine/reconstruct, on-demand flashcards and per-user scheduling; global Up Next view.
4. Primary agent: Eve-native supervisor with bounded durable delegation and truthful streamed states. Retain compatibility until state/call-site inventory supports retirement.
5. Quality and debt retirement: evaluate grounding, duplication, outcomes, retries/authorization, delegation benefit; retire only proven redundant paths.

## Acceptance scenarios

- Captures remain recoverable if extraction/enrichment fails; retries do not duplicate source effects or artifacts.
- Extraction may create zero, one, or several useful Zettels. Repeated ideas add source evidence to an existing artifact; distinct/contradictory ideas stay distinct and linked.
- One Artifacts home searches raw and generated items while preserving type, provenance, and workspace isolation.
- Multi-source quizzes pin source versions; question evidence resolves to the correct source; user attempts remain scoped to the user and quiz.
- Explain It handles correct, partial, mistaken, ambiguous, and conflicting answers with evidence and adapts follow-up questions.
- Graph combine creates an evidence-linked synthesis; reconstruction checks verified edges and records learner attempts separately.
- Flashcards are generated on request; Again/Hard/Good/Easy scheduling is isolated per user.
- Simple chat finishes directly. Substantial work has bounded tools/budgets, durable observable state, cancellation, retry/recovery, and truthful failure. Unauthorized tools and external writes remain blocked pending approval.

## Decisions and delivery

Product decisions were confirmed with the user on 2026-11-09. Notebook owns quiz authoring and all learning modes; `/learn` is the cross-Notebook Up Next queue. Legacy per-document quiz routes remain readable. Implemented slices: proposed/source-linked duplicate-aware Zettels, bounded capture generation outside long transactions, per-user artifact feedback, multi-source pinned quizzes with the existing runner, source-grounded adaptive Explain It sessions, on-demand source-quoted flashcard decks with per-user due scheduling, React Flow idea synthesis/connection plus persisted relationship recall attempts, and a unified searchable Artifacts gallery over raw sources, generated artifacts, quizzes, and flashcard decks. Migrations 0291-0297 add quiz manifests and request keys, feedback, flashcard and Explain It records, graph recall attempts, and quiz Notebook ownership. Remaining slices: provide feedback controls for quiz/deck outputs and use learning outcomes in future generation, fully separate optional Firecrawl enrichment from extraction/Zettel generation, and simplify the Eve supervisor/background task lifecycle while retaining compatibility.
