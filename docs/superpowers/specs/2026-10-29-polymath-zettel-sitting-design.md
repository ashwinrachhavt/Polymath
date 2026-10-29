<!-- /autoplan restore point: "/Users/ashwin/Projects/axiom/.gstack/tmp/autoplan/zettels-autoplan-restore-20261029-011002.md" -->
## Implementation plan
# Polymath rename + Zettel Sitting creator — design (settled 2026-10-29)

Status: approved through brainstorming + two grilling rounds (all defaults) + external design review incorporated. Approach A, one combined PR on branch `zettels`.

**Naming (owner decision 2026-10-29):** the user-facing name for the zettel feature is **"Ideas"** — nav entry, collection page ("Ideas"), actions ("New idea", "New sitting"), and all copy. "Zettel" survives only as the internal artifact kind (`artifacts.kind = "zettel"`) where it is already load-bearing in schema, links, and the accept pipeline. This file keeps "zettel" when speaking technically of that artifact kind.

## 0. Canonical definitions (settle vocabulary once)

- **Zettel** — a versioned, independently useful expression of one idea, question, observation, or method, connected to its origins and to the other ideas that give it meaning. Implemented as an **artifact** (`kind: "zettel"`) with versions, tags, links, embeddings. Atomic ≠ short: the test is "can I reuse this idea in a different argument without carrying an unrelated idea along?"
- **Recall item** — the scheduled retrieval object (existing `cards` table, migration 0240). A zettel may have several recall items; they are different things and the two words are never interchangeable.
- **Sitting** — a working session that contextualizes knowledge but never owns it. Cards belong to the artifact store; a sitting references them.
- **Claim / source / evidence** — keep existing meanings from `src/domains/knowledge/zettels.ts` (claims table, sources table, claim_evidence).

Optional `role` field on zettels (claim | explanation | question | method | observation | hypothesis | null). Never gate writing on classification.

## 1. Acceptance boundary (the review's central demand)

Saved ≠ accepted. Three paths, one shared contract:

1. **User writes in a sitting** → saves immediately as an **authored** artifact version (authorship = acceptance, same as notes today).
2. **AI extracts from a document** → `proposeZettels` → proposals (unchanged) → user accepts via `acceptZettel` (unchanged: concept, claim, evidence, source edge, audit event).
3. **AI drafts/suggests inside a sitting** → exists only as the run's **proposal payload**, visibly marked AI-suggested in the editor; **Keep** or direct edit adopts it as a new authored version; Discard removes it. Never written as an artifact version before adoption.

AI-generated zettel text never bypasses the proposal/acceptance semantics.

## 2. Data model

- **`zettel_sittings`** (next available migration number — verify against `src/db/migrations/meta/_journal.json` at implementation time; 0252 is taken): id, workspace_id, topic, tags jsonb, source_context, closing_reflection (nullable, deferred feature), started_at, ended_at (null = open), timestamps. Partial index on open sittings. Multiple open sittings allowed per workspace.
- **`zettel_sitting_cards`**: sitting_id, artifact_id, position, role_in_sitting (`created_here` | `referenced_here` | `revised_here`). UNIQUE (sitting_id, artifact_id). Workspace-consistency check on insert. Deleting a sitting cascades only join rows — cards survive. Ended sittings reopen browse-only.
- **`artifacts.metadata` jsonb** (nullable): Bloom suggestion (level, source, rationale, model+prompt version, artifact version analyzed), never user mastery. Human `updated_at` untouched by annotation writes.

## 3. Creation stream = an agent run (durable)

- The sitting's AI work runs as a real **`agent_runs`** row (state machine, `lastEventSeq` for SSE reconnect) with **`agent_steps`** per stage — operationId = run id. Reuses existing machinery; no parallel operation table.
- Stage pipeline (two concurrent tracks after save, mirroring the donor): Track A = embed + link discovery; Track B = analysis + enrichment. Version-guarded throughout (`skipped: edited`, `skipped: busy` semantics preserved from `embedArtifact`).
- **SSE is a view, not the record.** Route pattern copied from `runs/[runId]/stream` (cursor reconnect, replay-safe). Failure contracts: save-first-then-enrich; connection drop mid-stream loses nothing committed; user edit during enrichment cannot be overwritten (version guard); one stage failing never blocks siblings; quota-unavailable preserves writing and reports which assistance didn't run.
- **Event protocol** (deliberate, versioned): `protocolVersion`, `operationId` (run id), `artifactId`, `artifactVersionId`, stage + status + payload. Events: `card_saved`, `token`, `thinking`, `links_found`, `enrichment`, `bloom_suggested`, `stage_started/completed/failed`, `warning`, `done`, `error`. Durable success events emitted after commit.
- **Persistence: allowlisted stage outcomes only** (agent_steps payloads: "embedded v3", "4 related candidates", "title + 3 tags"). Live tokens/thinking stream to the connected client but are **never persisted** — no transcripts on reopen, redaction problem eliminated. Alfred's stream-evidence localStorage layer is dropped. Each stage failure emits one structured log line with run id, stage name and the allowlisted error string.
- **Quota**: one operation admission per stream (product rule), plus per-provider-call usage accounting underneath (zero or more generation calls, zero or more embedding calls, retries accounted).

## 4. Decomposition = proposal-generating compiler

Paste > threshold → pipeline: preserve original → identify structure + intellectual roles → propose candidates with **exact source version + span anchors** → compare against existing knowledge (similarity candidates shown, not asserted) → review UI (create / merge / link / skip) → idempotent batch commit. Invariants: original untouched; no invented quotes (verbatim locate against extraction, same as `proposeZettels`); qualifiers/negations/attribution preserved; extraction vs synthesis distinguished; multiple passages may support one candidate; omitted material surfaced; user merges/edits before accept; commit is idempotent (dedupe key = document + span). v1 bounded: one JSON call, ~20k char input cap, schema-validated, commit-nothing-on-failure. Roles route destinations (principle → zettel; decision record → linked note; checklist → task, not zettel).

## 5. Connections = candidates vs accepted, surfaced

- `artifact_links` already distinguishes: `linkType: "semantic"` = machine-rewritten candidate (carries score, skipped for explicitly-linked neighbors) vs explicit links = accepted.
- Sitting UI shows semantic candidates as **suggested links with a readable explanation sentence** ("This qualifies 'Retries improve reliability': retries are safe only when duplicate effects are controlled.") and an explicit accept action. Accept writes an explicit link row. Backlinks display but are not symmetric meaning.
- No new competing connection notion; `materializeSemanticEdges` stays the only automatic edge writer.
- pgvector parity is defined by observable outcomes (candidate recall, workspace isolation, stale-vector handling, fallback), not "same behavior" hand-waving.

## 6. Bloom = practice suggestion, never mastery

- Keep the dot visuals; relabel as suggested practice ("Suggested: Apply"). Stored in artifacts.metadata as an annotation with model/prompt version + artifact version analyzed.
- Never converted to a knowledge-confidence score; learner performance stays exclusively in `card_reviews` (0240 system). A generated "high Bloom" card never counts as demonstrated mastery.

## 7. UI port (interaction quality, not store architecture)

- Components → `src/components/polymath/zettels/`: WorkspaceShell (SessionRail | WritingSurface | AmbientIntelligencePanel + ActionTasksSidebar), ghost-suggestion tiptap editor, stream panel, decomposition review, editor-bus. DecompositionReviewUI opens on long paste. The WritingSurface stream-event handling lives in a dedicated reducer module (`creation-stream-reducer.ts`) so the component stays presentational.
- **Store**: Zustand persist → **localStorage** (no IndexedDB/idb-keyval). Keys scoped by workspace+sitting; updatedAt-wins merge; hydration never silently overwrites newer server state; late streams cannot mutate a different sitting/card; two-tab tolerant (last-write-wins on drafts, server authoritative for saved content).
- **Ownership table**: server owns accepted content+versions+stage outcomes; local owns unsaved writing (with explicit recovery); client UI owns selection/panels; runtime owns abort handles; AI suggestions are version-bound proposals.
- Routes: `/polymath/knowledge/zettels/session/new`, `/polymath/knowledge/zettels/session/[sittingId]` (server hydration + server actions for create/end; SSE for the stream). Seeding a new sitting from the inbox flow happens via the "New sitting" route with a document reference in the query string — there is no separate `seed` action.
- Entry points: "New sitting" button on the zettels collection page; "Sittings" destination in the knowledge nav group; the inbox `generate-zettels` action repointed from the collection page to the New-sitting route (CEO-accepted scope item).
- Design: axiom's existing tokens (no `--alfred-*` vars); serif writing surface, mono metadata chips — same feel through this repo's system. New deps: `zustand` only.

## 8. Generation provider: + Cloudflare Workers AI (opt-in)

- New `cloudflare.ts` adapter in `src/integrations/generation/` implementing `GenerationProvider` (REST `POST /accounts/{account}/ai/run/{model}`, env keys `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` — both already present in `.env` — model via `CLOUDFLARE_MODEL`), with streaming support so it can serve the creation stream.
- **Seam extension (required)**: `GenerationProvider` gains an **optional** `stream?(input): AsyncGenerator<{type: "thinking" | "token", content: string}>` method alongside the existing `generate()`; the `GenerateInput`/quota contract is otherwise unchanged. Gemini, OpenRouter and Cloudflare adapters implement `stream()` progressively; the fixture provider fakes it for tests. When the selected provider cannot stream, Track B runs token-less (stage outcomes still emitted: analysis_started → analysis_completed without `token` events) — never an error.
- **Sitting deletion authorization**: any workspace member may delete an open sitting they can view; deletion cascades only `zettel_sitting_cards` rows (artifacts survive), records an audit event, and is blocked for ended sittings (they are records, not workspaces).
- Selection: `GENERATION_PROVIDER=cloudflare` opts in explicitly; the free-first default chain stays **Gemini → OpenRouter** (2026-10-27 owner decision untouched). Fixture provider extended for tests.
- Embeddings stay on the existing pgvector pipeline (CF embeddings adapter = clean follow-up, out of scope).

## 9. Rename sweep (Alfred → Polymath)

- Routes: `src/app/(workspace)/alfred/` → `polymath/` via git mv (13 route dirs); all internal hrefs; `AppSlug`/`ProductId` "alfred" → "polymath"; products.ts name "Polymath".
- Agent: `ensureProfile` default, onboarding prompt ("use Polymath"), thread.ts, eve-driver defaults, `eve/alfred/` → `eve/polymath/` (git mv), gateway policy import.
- DB migration: `UPDATE agent_profiles SET name='polymath' WHERE name='alfred'` — verified safe: name is unique per workspace, all FKs point at id not name, scoped update cannot collide with user-chosen names. `agentPrincipal.key` values left alone (immutable, machine-facing); default for new principals changes.
- `next.config.ts`: catch-all redirect `/alfred/:path*` → `/polymath/:path*`.
- Tests/e2e (~83 refs) updated in the same sweep. Historical comments may keep "Alfred" where they cite the donor repo.

## 10. Explicitly out of scope (this PR)

Neo4j nexus projection; Qdrant; end-of-sitting synthesis prompts; learner modeling; large-document hierarchical decomposition; cross-domain analogy discovery; belief-evolution UI; automated source-change maintenance; knowledge-gardening view; CF embeddings adapter; agent-instruction authority boundaries (§9F of the review); collection-page redesign beyond the single "New sitting" button (CEO-deferred); delight-scan items (kbd nav polish, sitting templates, tag inheritance UI, reading-time hints, export-to-notebook).

## 11. Testing (adversarial cases required)

Double-submit creates one artifact; connection drop immediately after commit; edit-during-enrichment; sitting switch while old events arrive; foreign-workspace artifact rejected with ARTIFACT_WORKSPACE_MISMATCH (§15.4); invented quote dropped by extraction; negation preserved through extraction; batch acceptance retried idempotently; embeddings unavailable (card usable, indexing visibly unavailable, retry re-runs the stage §15.3); rejected suggestions don't reappear on recomputation (dismissed-candidates store, §14.9); browser recovery with local draft vs newer server version (conflict UI §14.4); Bloom annotation never recorded as mastery; sitting deletion authorization (member deletes open sitting → join rows cascade, artifacts survive + audit event; ended sitting deletion blocked §15.8); CREATION_IDLE_MS debounce fires Track B exactly once per pause (§14.2); AI suggestion Enter/Escape adoption (§14.3); DECOMPOSE_PASTE_CHARS threshold and DECOMPOSE_MAX_CHARS rejection (§15.1); stage_failed payload carries {stage, code, message, operationId} and only allowlisted outcomes persist (§15.2); provider config errors fail at selection naming the variable (§15.6); migration collision case renames to polymath-2 (§15.7); credentials never appear in logs/events (§15.9). Rename: old-URL redirect coverage; serialized-identifier audit. Journey e2e: type → pause → card saved → rail → reopen (fixture provider), TEST_DATABASE_URL conventions.

## 12. Donor-to-target behavior matrix

| Donor (alfred) | Target (axiom) | Parity evidence |
|---|---|---|
| zettel_cards table | artifacts (kind zettel) + versions | collection page + link graph work unchanged |
| ZettelSession tables | zettel_sittings + join table | sitting create/end/hydrate actions |
| SSE orchestrator (Python) | agent_runs + agent_steps + SSE route | run row, steps, reconnect cursor |
| Qdrant link search | pgvector + materializeSemanticEdges | candidate recall + isolation tests |
| creation-stream events | versioned protocol (§3) | event schema test |
| stream-evidence localStorage | allowlisted stage outcomes | reopen shows outcomes, no transcripts |
| Zustand + IDB mirror | Zustand + localStorage, workspace-scoped | draft recovery + isolation tests |
| Bloom inference → card columns | bloom_suggested → artifacts.metadata | annotation versioning test |
| ghost-suggestion editor | port with Keep/Discard adoption | acceptance boundary UI test |
| decomposition bulk-create | proposal compiler + review + idempotent commit | invariants test list §11 |
| alfred routes/branding | polymath everywhere + redirects | redirect e2e + identifier audit |

## 13. Honest deltas

SSE reconnect follows the runs-route pattern (NDJSON frames, not raw SSE frames) — same transport the repo already trusts. Decomposition v1 is one bounded call, not hierarchical. Sitting synthesis deferred. Cloudflare is opt-in, not default.

## 14. Sitting experience spec (design review, 2026-10-29)

### 14.1 New-sitting opening frame
Editor focused with cursor blinking; topic optional and inline (placeholder "Untitled sitting — name it later"); Ambient panel rendered in its resting state ("Assistance starts when you pause"); rail shows the sitting's name and an empty-cards hint ("Cards you write land here"). A user can produce a card without ever touching topic, tags, or the panels.

### 14.2 AI trigger (the feature's heartbeat)
Track B fires when the editor is idle **1.2s** with a non-empty draft ≥ 8 chars (the donor's 350ms felt twitchy for prose; 1.2s reads as intentional). Between idle and the first `thinking` event the panel shows a visible "Reading your draft…" state — silence never reads as broken. The constant lives in one named module constant (`CREATION_IDLE_MS = 1200`) with a test asserting the debounce.

### 14.3 AI-suggestion treatment (the trust-bearing pixels)
Streamed AI text renders in a distinct suggestion style: muted/tinted run with a small "AI suggestion" marker, locked from mixing with typed text mid-run. **Keep** adopts it as an authored version; **Discard** removes it; both are always-visible inline actions on the suggestion block, keyboard-reachable (Enter = Keep, Escape = Discard while the suggestion is focused — this is core interaction, not polish).

### 14.4 States table (per panel)
```
PANEL/FEATURE        | RESTING              | ACTIVE/STREAMING         | FAILED                        | UNAVAILABLE
---------------------|----------------------|--------------------------|-------------------------------|------------------------------
Ambient panel        | "Assistance starts   | live stages animate      | stage_failed inline with one  | "Link discovery needs AI
                     | when you pause"      | (thinking → enrichment)  | retry button per stage        | quota — your card is saved
                     |                      |                          |                               | and will index when quota
                     |                      |                          |                               | returns"
Stream panel         | hidden               | token/thinking live      | errors listed, siblings noted | quota notice per skipped stage
Card rail            | empty hint (14.1)    | card lands on card_saved | —                             | —
Draft conflict       | —                    | —                        | —                             | editor keeps local draft on top
                                                                                                     with dismissible "Server has a
                                                                                                     newer saved version — compare /
                                                                                                     keep mine / take server"
```
Quota copy is exact wording, not a contract summary. Stage failure offers per-stage retry; siblings never blocked.

### 14.5 Success moment + end-of-sitting arc
`card_saved` lands as a titled entry in the SessionRail with a subtle entrance (one authored motion moment — exponential ease-out from visible default, nothing else animates). **End sitting** shows a lightweight inline confirm ("Ending saves this sitting as a record — you can read it but not add to it") and lands on a closing summary: cards written, suggestions kept, suggested links pending — routed to the sitting's browse-only view with a path back to Ideas. *Un-end:* pending owner decision at the gate (taste: hard record vs. brief un-end window).

### 14.6 Decomposition review placement
Paste > threshold triggers a non-blocking inline banner ("Analyzing paste — review proposed extractions") with progress and cancel; the editor keeps the pasted original untouched and in place; the review list opens as a focused side panel the user can dismiss and reopen. Loading state is the banner's progress; commit-nothing-on-failure shows the failure inline with a retry.

### 14.7 Mid-run reopen contract
Reopening a sitting with an in-flight run attaches to the run's stream from the current cursor (machinery already supports it): committed outcomes render immediately, live stages animate after. Reopen of a finished run shows outcomes only.

### 14.8 Multiple open sittings
Rail lists open sittings with open/closed indicator; one active at a time in the shell; non-active open sittings' runs continue server-side, panels hydrate on switch via cursor reconnect.

### 14.9 Suggested links UX
Suggestions render inside the card's metadata strip with accept/dismiss in place; a per-sitting "N suggested links" count in the ActionTasksSidebar routes to batch review; dismissals persist in a per-artifact dismissed-candidates list (the §11 no-reappear test asserts against it).

### 14.10 Inbox handoff
The repointed inbox action opens the sitting with a visible source chip ("From: {document title}") in the header, the document openable for reference, and a one-line inline prompt "Extract proposals from this document" (§1 path 2) rather than an empty editor.

### 14.11 "New idea" direct flow
"New idea" on the Ideas collection opens a minimal sitting-less editor route that saves as an authored artifact version (§1 path 1: authorship = acceptance) — cheap, coherent, included.

### 14.12 Bloom placement
Dots render in the card's metadata chips row with label "Suggested practice: {level name}"; inert in v1 (no tap action — routing to recall items is a later slice).

### 14.13 Responsive & accessibility
Shell grid collapses at 1024px to a single column (rail becomes a top drawer, ambient panel below the editor). Keyboard: Cmd+Enter finalize, Cmd+]/Cmd+[ card navigation, Enter/Escape on suggestions (14.3), all actions tab-reachable, 44px minimum touch targets, stream panel is an ARIA live region (polite), body text ≥16px, contrast ≥4.5:1.

## 15. Error & constant contracts (DX review, 2026-10-29)

### 15.1 Named constants
`CREATION_IDLE_MS = 1200` (§14.2). `DECOMPOSE_PASTE_CHARS = 2000` — pastes at or above this length trigger decomposition review; below it, the paste lands as plain text. `DECOMPOSE_MAX_CHARS = 20000` — input above the cap is **rejected, never truncated** (silent truncation would violate §4's surfaced-omissions invariant): inline message "Paste is too long to analyze at once — split it or select a section." Both constants tested.

### 15.2 Stage failure payload (agent-ready contract)
Every `stage_failed` event carries `{stage, code, message, operationId}` where `message` is one human sentence and `code` is stable. The allowlist of stage-outcome strings is enumerated in the event-schema test: `saved`, `embedded:v{n}`, `links:{n}`, `enriched`, `bloom:{level}`, `skipped:edited`, `skipped:busy`, `failed:{stage}` — nothing outside the list may be persisted. Non-quota stage failures render the message + per-stage retry; the client surfaces `operationId` so a user can quote it.

### 15.3 Quota copy (fix + recovery)
"Link discovery needs AI quota — your card is saved. Add credits or ask an admin to raise the quota, then retry indexing." The UNAVAILABLE state includes a **Retry indexing** button; a test asserts quota recovery re-runs the skipped stage.

### 15.4 Foreign-workspace rejection
The server action rejects a workspace-mismatched artifact with a typed error `{code: "ARTIFACT_WORKSPACE_MISMATCH", message: "That card belongs to another workspace."}` rendered as the action's standard error surface — never an SSE event (the join never happens).

### 15.5 Decomposition failure copy
Inline in the review panel: "{code}: the analysis failed — nothing was committed. Retry." plus the reassurance that the original paste is untouched. Over-cap input uses §15.1's rejection message before any provider call.

### 15.6 Provider config validation (fail fast)
Provider selection validates env at selection time: missing/invalid `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_KEY`, or `CLOUDFLARE_MODEL` (or unknown `GENERATION_PROVIDER` value) throws `GenerationUnconfiguredError` (or a typed config error) naming the exact variable and the value to set — at selection, never mid-stream.

### 15.7 Migration collision handling
The rename migration must handle a workspace where a user already chose "polymath" while an "alfred" profile exists: pre-rename collision check renames the incoming profile to `polymath-2` (audit-evented) instead of failing the deploy. The migration test adds the collision case alongside the user-chosen-name case.

### 15.8 Ended-sitting deletion UI
The delete action is disabled (not hidden) for ended sittings with tooltip "Ended sittings are records" — progressive disclosure over error paths.

### 15.9 Event protocol examples + redaction
The event-schema test embeds one example NDJSON frame per event family (e.g. `{"protocolVersion":1,"operationId":"<run-uuid>","artifactId":"<uuid>","artifactVersionId":"<uuid>","event":"card_saved","payload":{…}}`). `CLOUDFLARE_API_KEY` and all credential values never appear in structured log lines, error events, or step payloads — asserted by test.

### 15.10 Donor semantics inlined (implementer unblocking)
The load-bearing donor semantics are inlined at their point of use, not delegated: version-guard rules ("a stage writes only if the artifact's current version is unchanged since it started; otherwise skipped:edited"), adoption transition ("Keep/edit converts the run's proposal payload into a new authored version in one transaction; Discard drops the payload"), and the §14.2 rationale. "The donor" references remain only as historical provenance.

Label mapping (§0 addition): **Ideas** = the collection surface; **Sittings** = the nav destination listing sittings; **New sitting** = the action that opens the workspace.

## 16. Execution substrate & rename corrections (eng review, 2026-10-29)

### 16.1 Creation-run execution model (the durable-stream correction)
The copied runs-route pattern's durability lives in the external Eve bridge; creation runs have no bridge. Therefore: **the creation run executes in-process within the originating stream connection's lifetime.** §14.8 is corrected: a non-active open sitting's run continues only while its originating connection lives; there is no server-side continuation across disconnects. Reconnect semantics (§14.7 corrected): a new connection attaches to the run's **durable events only** (committed outcomes, allowlisted) via cursor replay; tokens/thinking are unrecoverable by design — the panel shows the "Reading your draft…" resting state until the next durable event. A startup sweep fails stranded `running` creation runs (older than a threshold) with a `stage_failed` outcome ("Run interrupted — retry to finish enrichment"). Option (b) (after()/queue detachment) is a future slice; not in this PR.

### 16.2 Eve bridge rename compatibility
`eve/alfred/` is an agent-identity contract: `eveAgentForProfile` maps profile name → mount dir, `next.config.ts` registers the alias, session refs in existing `agent_runs.sessionRef` rows were minted under "alfred". Corrections: (a) `eveAgentForProfile` gains a lineage mapping — a profile whose history is "alfred" resolves to the renamed mount for historical runs; historical conversations render read-only for generation (no new bridge sessions under a mismatched name); (b) deploy ordering: the rename migration and the code rename ship in the same deploy; running sessions are drained by the existing session cleanup; (c) the bridge-side prompt/config keyed to the agent name is updated in the same sweep (the mount rename covers it — the bridge reads the directory).

### 16.3 Profile machine-key lookup (the collision-path fix)
`ensureProfile` finds by exact name — the collision rename to `polymath-2` (§15.7) would make a later `ensureProfile(ws, "polymath")` create a second profile. Fix: the migration records lineage in the profile row's metadata (`{renamedFrom: "alfred"}`); `ensureProfile` resolves the workspace's polymath-lineage profile by metadata first, exact name second. The missed call sites join the §9 list: `src/domains/focus/follow-up.ts:188`, `src/domains/knowledge/note-ai.ts:106`, `src/domains/knowledge/automation-runs.ts:40,50,53`, `src/domains/knowledge/studio.ts:99`, `src/app/api/v1/runs/[runId]/stream/route.ts:94` (`profileName ?? "alfred"`), `commands.ts:386`'s machine-key doc updated. The migration test adds: post-collision `ensureProfile(ws, "polymath")` returns the renamed profile, not a new row.

### 16.4 Quota admission per run, not per stream
Admission is per **run** (operationId), cached on the run row — reconnects never re-admit. Usage accounting: a `metered()` wrapper on `GenerationProvider` records per-call usage (provider, model, tokens where reported) to the run row; adapters stay thin.

### 16.5 Typed config error
New `GenerationConfigError extends GenerationUnconfiguredError` carrying `{variable, expected}`; §15.6's test asserts the variable name and expected value appear. Unknown `GENERATION_PROVIDER` values keep the base class.

### 16.6 Route inventory completed
Third route: `/polymath/knowledge/ideas/new` (the §14.11 sitting-less editor; draft localStorage key scoped by workspace+`idea:new`, no sitting). Creation-stream endpoint: `POST /api/v1/polymath/sittings/[sittingId]/create-stream` (NDJSON, authedHandler + requireRole("member"), workspace-scoped run lookup — same guard shape as the runs route). Explicit note: **do not copy the `eveBridgeUnavailableReason` guard** — creation runs have no Eve session; a bridge outage must not 503 the creation stream.

### 16.7 PR sequencing within the single combined PR
Commit order: (1) rename sweep + redirect + identifier audit, (2) provider seam + CF adapter, (3) sittings domain + creation stream, (4) workspace UI, (5) decomposition + Bloom. A test asserts no internal href/rewrite target still resolves to `/alfred/*` (redirect-loop detection).

### 16.8 Metadata namespaces (concurrent-writer fix)
`artifacts.metadata` is namespaced: `metadata.bloom` (annotation, written by Track B), `metadata.dismissedCandidates` (user action), `metadata.sittingLineage` (profile rename). Writers merge **by namespace** (jsonb_set on their own key), never read-modify-write of the whole object — the repo's concurrent-writer lesson, applied structurally. A drizzle-trap note: annotation writes bypass `updated_at` auto-update via an explicit set that leaves the column untouched (drizzle's mutable helper would bump it; the Bloom test asserts `updated_at` unchanged after annotation).

### 16.9 Smaller corrections
- Per-sitting active-run cap: 1 concurrent creation run per sitting; a new pause reuses the sitting's open run (debounce dedupe key already prevents most).
- Decomposition destinations in v1: zettel and note only (checklist→task deferred with §10; task-write surface unspecced here).
- Closing-summary "suggestions kept" is derived from artifact version provenance (versions whose source is the sitting's run proposals), no new counter field.
- `stream()` is bounded by an overall deadline (reuse GENERATION_TIMEOUT_MS semantics: 30s without a durable event ends the stream with `stage_failed`).
- New tests: foreign-workspace run/stream access returns the same 404 shape as the existing route; stranded-run startup sweep; redirect-loop detection; background-tab throttle behavior pinned (debounce may fire late under throttling — acceptable, no duplicate runs).

### 16.10 Eng accepted obligations
- Creation runs execute in-process; no server-side continuation across disconnects; reconnect replays durable events only; stranded-run sweep with stage_failed.
- Eve bridge lineage mapping for historical sessions; read-only historical generation; same-deploy ordering.
- ensureProfile lineage resolution (metadata first, name second); all missed call sites renamed; collision-path test.
- Quota admitted per run; metered() usage wrapper; GenerationConfigError with {variable, expected}.
- Full route inventory incl. /polymath/knowledge/ideas/new + named stream endpoint + no-eve-guard note.
- Five-commit internal sequencing + redirect-loop test.
- Namespaced metadata with merge-by-namespace; updated_at trap named + tested.
- Per-sitting run cap; v1 decomposition destinations zettel+note; derived suggestions-kept; stream deadline; four new tests listed.

<!-- autoplan-accepted:ceo -->
- Canonical vocabulary holds for the whole feature: Zettel = versioned artifact (kind "zettel"); recall item = the 0240 `cards` table; a sitting contextualizes but never owns cards; the words are never interchangeable. Verified by a vocabulary test asserting proposal acceptance writes an artifact, not a card row, and sitting deletion leaves artifacts intact.
- The acceptance boundary is enforced on all three paths: user-typed text saves as an authored artifact version; AI-drafted text exists only as a run proposal payload until Keep/edit adoption (never an artifact version before adoption); document extraction keeps the existing propose→accept transaction unchanged. Verified by a test that a stream's AI text without adoption leaves zero new artifact versions.
- The creation stream runs as an agent_runs row with agent_steps per stage; SSE reconnect uses the runs-route cursor pattern; durable success events are emitted only after their commit. Verified by an integration test that kills the connection after card_saved and finds the run row + card artifact intact on retry with the same idempotency key.
- Persistence rule: agent_steps payloads carry allowlisted stage outcomes only; raw token/thinking transcripts are never persisted anywhere (no DB, no localStorage). Verified by a test asserting reopen shows stage outcomes and zero transcript bytes.
- Decomposition invariants 1-8 (§4) each have a named test in the plan's test section; the batch commit is idempotent per (document, span) dedupe key. Verified by double-commit test producing one artifact set.
- Cloudflare adapter is opt-in only (GENERATION_PROVIDER=cloudflare); the Gemini→OpenRouter free-first default is untouched. Verified by a provider-selection test asserting the default chain without env overrides.
- The rename migration is scoped `UPDATE agent_profiles SET name='polymath' WHERE name='alfred'`; agentPrincipal.key values are not migrated. Verified by a migration test on a seeded workspace with a user-chosen profile name (unchanged) and an alfred profile (renamed).
- Old /alfred/* URLs redirect via next.config catch-all to /polymath/*. Verified by redirect e2e.
<!-- /autoplan-accepted:ceo -->
<!-- autoplan-accepted:design -->
- §14.1-14.13 sitting experience spec is accepted implementation contract: opening frame, CREATION_IDLE_MS=1200 debounce (named constant + debounce test), AI-suggestion treatment with Enter=Keep/Escape=Discard, per-panel states table with exact quota copy and per-stage retry, card_saved rail entrance (one authored motion moment), End-sitting confirm + closing summary, decomposition non-blocking banner + side panel, mid-run reopen attaches from current cursor, one-active-sitting rail with server-side continuation, suggested-links strip + dismissed-candidates store + batch count in ActionTasksSidebar, inbox source chip + "Extract proposals" prompt, "New idea" direct route (authored artifact), Bloom dots inert in v1, responsive collapse at 1024px + keyboard map + 44px targets + ARIA live region.
- §11 tests extended: CREATION_IDLE_MS debounce fires once per pause; AI suggestion Enter/Escape adoption; dismissed-candidates no-reappear asserted against the named store.
- Ended-sitting finality (un-end vs hard record) is a queued taste decision for the Phase 4 gate — the confirm copy (§14.5) ships either way.
- No DESIGN.md exists; the plan aligns to axiom's existing tokens; /design-consultation recommended at the gate, not blocking.
<!-- /autoplan-accepted:design -->
<!-- autoplan-accepted:dx -->
- §15.1-15.10 error & constant contracts are accepted implementation contract: named constants CREATION_IDLE_MS=1200, DECOMPOSE_PASTE_CHARS=2000, DECOMPOSE_MAX_CHARS=20000 (over-cap rejected, never truncated, tested); stage_failed payload {stage, code, message, operationId} with the enumerated stage-outcome allowlist (nothing outside persists); quota copy with fix + Retry indexing button + recovery test; ARTIFACT_WORKSPACE_MISMATCH typed rejection on the action surface; decomposition failure copy; provider config validation fails at selection naming the variable; migration collision renames to polymath-2 with audit event + collision test case; ended-sitting delete disabled with tooltip; event-schema test embeds one NDJSON example per event family; credentials never in logs/events (asserted); donor semantics inlined at point of use; label mapping Ideas/Sittings/New sitting.
- §11 test list extended with all §15 cases.
- No CAP4 error-contract conditions found (transcript elimination removes the main redaction surface).
<!-- /autoplan-accepted:dx -->
<!-- autoplan-accepted:eng -->
- §16.1: creation runs execute in-process within the originating connection; §14.7/§14.8 corrected (durable-events-only reconnect, resting state until next durable event, stranded-run startup sweep with stage_failed "Run interrupted — retry to finish enrichment"); no queue detachment in this PR.
- §16.2: eveAgentForProfile lineage mapping for historical "alfred" sessions; historical conversations read-only for generation; rename migration + code rename in the same deploy.
- §16.3: ensureProfile resolves polymath-lineage by metadata (renamedFrom) first, name second; missed call sites (follow-up.ts:188, note-ai.ts:106, automation-runs.ts:40/50/53, studio.ts:99, runs stream route:94) renamed; collision test asserts post-collision ensureProfile returns the renamed profile.
- §16.4: quota admitted per run (cached on run row), never per connection; metered() wrapper records per-provider-call usage to the run row.
- §16.5: GenerationConfigError carries {variable, expected}; §15.6 test asserts both appear.
- §16.6: route inventory complete (ideas/new route, named create-stream endpoint, no-eve-guard note).
- §16.7: five-commit internal sequencing; redirect-loop detection test.
- §16.8: metadata.bloom / metadata.dismissedCandidates / metadata.sittingLineage namespaces with merge-by-namespace; updated_at auto-update trap named and tested.
- §16.9: per-sitting active-run cap 1; decomposition v1 destinations zettel+note; suggestions-kept derived from version provenance; stream() bounded by 30s durable-event deadline; four new tests (foreign-workspace 404 parity, stranded-run sweep, redirect-loop, throttle pinning).
<!-- /autoplan-accepted:eng -->

## Review record

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"b46cef3df2715d412f9edbe6f7ba033344bb6079d713ee3cab2c82b4611f3d08","replacements":[{"oldText":"Status: approved through brainstorming + two grilling rounds (all defaults) + external design review incorporated. Approach A, one combined PR on branch `zettels`.","newText":"Status: approved through brainstorming + two grilling rounds (all defaults) + external design review incorporated. Approach A, one combined PR on branch `zettels`.\n\n**Naming (owner decision 2026-10-29):** the user-facing name for the zettel feature is **\"Ideas\"** — nav entry, collection page (\"Ideas\"), actions (\"New idea\", \"New sitting\"), and all copy. \"Zettel\" survives only as the internal artifact kind (`artifacts.kind = \"zettel\"`) where it is already load-bearing in schema, links, and the accept pipeline. This file keeps \"zettel\" when speaking technically of that artifact kind."},{"oldText":"- **`zettel_sittings`** (migration 0252): id","newText":"- **`zettel_sittings`** (next available migration number — verify against `src/db/migrations/meta/_journal.json` at implementation time; 0252 is taken): id"},{"oldText":"- **Persistence: allowlisted stage outcomes only** (agent_steps payloads: \"embedded v3\", \"4 related candidates\", \"title + 3 tags\"). Live tokens/thinking stream to the connected client but are **never persisted** — no transcripts on reopen, redaction problem eliminated. Alfred's stream-evidence localStorage layer is dropped.","newText":"- **Persistence: allowlisted stage outcomes only** (agent_steps payloads: \"embedded v3\", \"4 related candidates\", \"title + 3 tags\"). Live tokens/thinking stream to the connected client but are **never persisted** — no transcripts on reopen, redaction problem eliminated. Alfred's stream-evidence localStorage layer is dropped. Each stage failure emits one structured log line with run id, stage name and the allowlisted error string."},{"oldText":"- Components → `src/components/polymath/zettels/`: WorkspaceShell (SessionRail | WritingSurface | AmbientIntelligencePanel + ActionTasksSidebar), ghost-suggestion tiptap editor, stream panel, decomposition review, editor-bus. DecompositionReviewUI opens on long paste.","newText":"- Components → `src/components/polymath/zettels/`: WorkspaceShell (SessionRail | WritingSurface | AmbientIntelligencePanel + ActionTasksSidebar), ghost-suggestion tiptap editor, stream panel, decomposition review, editor-bus. DecompositionReviewUI opens on long paste. The WritingSurface stream-event handling lives in a dedicated reducer module (`creation-stream-reducer.ts`) so the component stays presentational."},{"oldText":"- Routes: `/polymath/knowledge/zettels/session/new`, `/polymath/knowledge/zettels/session/[sittingId]` (server hydration + server actions for create/end/seed; SSE for the stream).","newText":"- Routes: `/polymath/knowledge/zettels/session/new`, `/polymath/knowledge/zettels/session/[sittingId]` (server hydration + server actions for create/end; SSE for the stream). Seeding a new sitting from the inbox flow happens via the \"New sitting\" route with a document reference in the query string — there is no separate `seed` action."},{"oldText":"- Entry points: \"New sitting\" button on the zettels collection page; \"Sittings\" destination in the knowledge nav group.","newText":"- Entry points: \"New sitting\" button on the zettels collection page; \"Sittings\" destination in the knowledge nav group; the inbox `generate-zettels` action repointed from the collection page to the New-sitting route (CEO-accepted scope item)."},{"oldText":"- New `cloudflare.ts` adapter in `src/integrations/generation/` implementing `GenerationProvider` (REST `POST /accounts/{account}/ai/run/{model}`, `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`, model via env pattern like `ZETTEL_MODEL`), with **streaming** support so it can serve the creation stream.","newText":"- New `cloudflare.ts` adapter in `src/integrations/generation/` implementing `GenerationProvider` (REST `POST /accounts/{account}/ai/run/{model}`, env keys `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` — both already present in `.env` — model via `CLOUDFLARE_MODEL`), with streaming support so it can serve the creation stream.\n- **Seam extension (required)**: `GenerationProvider` gains an **optional** `stream?(input): AsyncGenerator<{type: \"thinking\" | \"token\", content: string}>` method alongside the existing `generate()`; the `GenerateInput`/quota contract is otherwise unchanged. Gemini, OpenRouter and Cloudflare adapters implement `stream()` progressively; the fixture provider fakes it for tests. When the selected provider cannot stream, Track B runs token-less (stage outcomes still emitted: analysis_started → analysis_completed without `token` events) — never an error.\n- **Sitting deletion authorization**: any workspace member may delete an open sitting they can view; deletion cascades only `zettel_sitting_cards` rows (artifacts survive), records an audit event, and is blocked for ended sittings (they are records, not workspaces)."},{"oldText":"CF embeddings adapter; agent-instruction authority boundaries (§9F of the review).","newText":"CF embeddings adapter; agent-instruction authority boundaries (§9F of the review); collection-page redesign beyond the single \"New sitting\" button (CEO-deferred); delight-scan items (kbd nav polish, sitting templates, tag inheritance UI, reading-time hints, export-to-notebook)."},{"oldText":"Bloom annotation never recorded as mastery. Rename: old-URL redirect coverage","newText":"Bloom annotation never recorded as mastery; sitting deletion authorization (member deletes open sitting → join rows cascade, artifacts survive + audit event; ended sitting deletion blocked). Rename: old-URL redirect coverage"}]} -->

<!-- autoplan-accepted:ceo -->
- Canonical vocabulary holds for the whole feature: Zettel = versioned artifact (kind "zettel"); recall item = the 0240 `cards` table; a sitting contextualizes but never owns cards; the words are never interchangeable. Verified by a vocabulary test asserting proposal acceptance writes an artifact, not a card row, and sitting deletion leaves artifacts intact.
- The acceptance boundary is enforced on all three paths: user-typed text saves as an authored artifact version; AI-drafted text exists only as a run proposal payload until Keep/edit adoption (never an artifact version before adoption); document extraction keeps the existing propose→accept transaction unchanged. Verified by a test that a stream's AI text without adoption leaves zero new artifact versions.
- The creation stream runs as an agent_runs row with agent_steps per stage; SSE reconnect uses the runs-route cursor pattern; durable success events are emitted only after their commit. Verified by an integration test that kills the connection after card_saved and finds the run row + card artifact intact on retry with the same idempotency key.
- Persistence rule: agent_steps payloads carry allowlisted stage outcomes only; raw token/thinking transcripts are never persisted anywhere (no DB, no localStorage). Verified by a test asserting reopen shows stage outcomes and zero transcript bytes.
- Decomposition invariants 1-8 (§4) each have a named test in the plan's test section; the batch commit is idempotent per (document, span) dedupe key. Verified by double-commit test producing one artifact set.
- Cloudflare adapter is opt-in only (GENERATION_PROVIDER=cloudflare); the Gemini→OpenRouter free-first default is untouched. Verified by a provider-selection test asserting the default chain without env overrides.
- The rename migration is scoped `UPDATE agent_profiles SET name='polymath' WHERE name='alfred'`; agentPrincipal.key values are not migrated. Verified by a migration test on a seeded workspace with a user-chosen profile name (unchanged) and an alfred profile (renamed).
- Old /alfred/* URLs redirect via next.config catch-all to /polymath/*. Verified by redirect e2e.
<!-- /autoplan-accepted:ceo -->
<!-- autoplan-accepted:design -->
- §14.1-14.13 sitting experience spec is accepted implementation contract: opening frame, CREATION_IDLE_MS=1200 debounce (named constant + debounce test), AI-suggestion treatment with Enter=Keep/Escape=Discard, per-panel states table with exact quota copy and per-stage retry, card_saved rail entrance (one authored motion moment), End-sitting confirm + closing summary, decomposition non-blocking banner + side panel, mid-run reopen attaches from current cursor, one-active-sitting rail with server-side continuation, suggested-links strip + dismissed-candidates store + batch count in ActionTasksSidebar, inbox source chip + "Extract proposals" prompt, "New idea" direct route (authored artifact), Bloom dots inert in v1, responsive collapse at 1024px + keyboard map + 44px targets + ARIA live region.
- §11 tests extended: CREATION_IDLE_MS debounce fires once per pause; AI suggestion Enter/Escape adoption; dismissed-candidates no-reappear asserted against the named store.
- Ended-sitting finality (un-end vs hard record) is a queued taste decision for the Phase 4 gate — the confirm copy (§14.5) ships either way.
- No DESIGN.md exists; the plan aligns to axiom's existing tokens; /design-consultation recommended at the gate, not blocking.
<!-- /autoplan-accepted:design -->
<!-- autoplan-accepted:dx -->
- §15.1-15.10 error & constant contracts are accepted implementation contract: named constants CREATION_IDLE_MS=1200, DECOMPOSE_PASTE_CHARS=2000, DECOMPOSE_MAX_CHARS=20000 (over-cap rejected, never truncated, tested); stage_failed payload {stage, code, message, operationId} with the enumerated stage-outcome allowlist (nothing outside persists); quota copy with fix + Retry indexing button + recovery test; ARTIFACT_WORKSPACE_MISMATCH typed rejection on the action surface; decomposition failure copy; provider config validation fails at selection naming the variable; migration collision renames to polymath-2 with audit event + collision test case; ended-sitting delete disabled with tooltip; event-schema test embeds one NDJSON example per event family; credentials never in logs/events (asserted); donor semantics inlined at point of use; label mapping Ideas/Sittings/New sitting.
- §11 test list extended with all §15 cases.
- No CAP4 error-contract conditions found (transcript elimination removes the main redaction surface).
<!-- /autoplan-accepted:dx -->
<!-- autoplan-accepted:eng -->
- §16.1: creation runs execute in-process within the originating connection; §14.7/§14.8 corrected (durable-events-only reconnect, resting state until next durable event, stranded-run startup sweep with stage_failed "Run interrupted — retry to finish enrichment"); no queue detachment in this PR.
- §16.2: eveAgentForProfile lineage mapping for historical "alfred" sessions; historical conversations read-only for generation; rename migration + code rename in the same deploy.
- §16.3: ensureProfile resolves polymath-lineage by metadata (renamedFrom) first, name second; missed call sites (follow-up.ts:188, note-ai.ts:106, automation-runs.ts:40/50/53, studio.ts:99, runs stream route:94) renamed; collision test asserts post-collision ensureProfile returns the renamed profile.
- §16.4: quota admitted per run (cached on run row), never per connection; metered() wrapper records per-provider-call usage to the run row.
- §16.5: GenerationConfigError carries {variable, expected}; §15.6 test asserts both appear.
- §16.6: route inventory complete (ideas/new route, named create-stream endpoint, no-eve-guard note).
- §16.7: five-commit internal sequencing; redirect-loop detection test.
- §16.8: metadata.bloom / metadata.dismissedCandidates / metadata.sittingLineage namespaces with merge-by-namespace; updated_at auto-update trap named and tested.
- §16.9: per-sitting active-run cap 1; decomposition v1 destinations zettel+note; suggestions-kept derived from version provenance; stream() bounded by 30s durable-event deadline; four new tests (foreign-workspace 404 parity, stranded-run sweep, redirect-loop, throttle pinning).
<!-- /autoplan-accepted:eng -->
### CEO phase (SELECTIVE EXPANSION, 2026-10-29)

REALITY: premise-table pass zettel-as-artifact (zettels.ts accept writes artifact), agent_runs/agent_steps machinery, provider seam, per-workspace unique profile name with id-pointing FKs all verified in-session src/domains/agents/schema.ts:96
REALITY: already-done pass git fetch origin main clean; no commits since 2026-10-28 touch named knowledge/agents/generation files 75378a7
REALITY: surface-check pass ZETTEL_MODEL env pattern verified; CF route POST /accounts/{id}/ai/run/{model} from owner-provided Workers AI docs src/integrations/zettels/extractor.ts:73
REALITY: binding-decisions pass no branch decision records found; free-first provider order (owner decision 2026-10-27) honored untouched src/integrations/generation/provider.ts:74
REALITY: numbers pass 13 route dirs, 297 refs/133 files, ~83 test refs [measured]; 20k decomposition cap [estimated]; next migration = 0260 after 0259 src/db/migrations/0259_note_comments.sql:1
REALITY: deferred-asks pass review §9 items (synthesis, belief history, gardening, CF embeddings, authority boundaries) listed in plan §10 with reasons docs/superpowers/specs/2026-10-29-polymath-zettel-sitting-design.md:80
REALITY: pr-count pass no .gstack/ship-policy.json; default one PR per wave matches the settled one-combined-PR decision docs/superpowers/specs/2026-10-29-polymath-zettel-sitting-design.md:1
- Mode: SELECTIVE EXPANSION (pipeline-mandated). Spec review loop: 2 iterations, 6 issues found/fixed, score 8/10 PASS.
- Sections 1–11 findings: 2×P2 auto-approved (stream-event reducer module named; per-stage structured log line). All other sections clean — examined architecture/deps, error paths, auth boundaries, async ordering (edit-vs-enrichment version guard), test pyramid, N+1 (batch link reads per sitting), additive-migration rollout, reversibility 4/5, UX state coverage.
- Diagrams: system architecture + user flow (in review record; to be embedded as code comments at implementation).
- Outside voice (Codex): quota exhausted — unavailable; native spec review completed (2 rounds). Coverage: subagent-only.
- Error & Rescue Registry and Failure Modes: 0 CRITICAL GAPS (7 codepaths mapped: provider stream, embed, link-search, enrichment, decomposition, SSE route, draft store; all rescued, all tested, none silent).

### NOT in scope
Deferred (TODOS.md): collection-page redesign; delight-scan items (kbd nav polish, sitting templates, tag inheritance UI, reading-time hints, export-to-notebook).
Rejected/out (plan §10): Neo4j projection, Qdrant, sitting synthesis, learner modeling, hierarchical decomposition, analogy discovery, belief-evolution UI, source-change maintenance, gardening view, CF embeddings, agent-instruction authority boundaries.

### What already exists (reused)
artifacts/artifactVersions/artifactLinks; proposeZettels/acceptZettel lineage; agent_runs/agent_steps + runs SSE route; embedArtifact + materializeSemanticEdges; GenerationProvider seam + quota; pgvector. New: sittings tables, creation-stream service, workspace components, CF adapter, rename.

### Dream state delta
This plan takes Polymath from "knowledge stored" to "knowledge made" — the acceptance boundary, sitting machinery, and run-based stream are the exact foundations the 12-month ideal (zoomable knowledge system with belief history and gardening) builds on. Remaining gap after this PR: synthesis, belief evolution, gardening (all §10).

### Implementation Tasks

- [ ] **T1 (P1, human: ~4h / CC: ~30min)** — Generation seam — add optional `stream()` to GenerationProvider + fixture/gemini/openrouter/cloudflare adapters
  - Surfaced by: Spec review 3.1 — streaming seam unresolved
  - Files: src/integrations/generation/provider.ts, fixture.ts, gemini.ts, openrouter.ts, cloudflare.ts
  - Verify: provider-selection test + stream() contract test with fixture provider
- [ ] **T2 (P1, human: ~6h / CC: ~45min)** — Sittings domain — zettel_sittings + join table migration, create/end/join actions, workspace-consistency + deletion authorization
  - Surfaced by: plan §2 + reviewer minor (deletion rules)
  - Files: src/domains/knowledge/schema.ts, new sittings module, next free migration, src/db/migrations/meta/_journal.json
  - Verify: integration tests (isolation, cascade, ended-blocked)
- [ ] **T3 (P1, human: ~16h / CC: ~2h)** — Creation stream service — agent_runs pipeline, two tracks, version guards, event protocol, allowlisted outcomes
  - Surfaced by: plan §3; Section 2 error map
  - Files: src/domains/knowledge/creation-stream.ts (new), agents domain reads
  - Verify: kill-connection-after-commit integration test; transcript-never-persisted test
- [ ] **T4 (P1, human: ~20h / CC: ~3h)** — Workspace UI port — shell/rail/surface/ambient/tasks/ghost-editor/decomposition/reducer, zustand localStorage store
  - Surfaced by: plan §7; Section 5 (reducer module)
  - Files: src/components/polymath/zettels/*, routes under src/app/(workspace)/polymath/
  - Verify: journey e2e (fixture provider); acceptance-boundary UI test
- [ ] **T5 (P1, human: ~8h / CC: ~1h)** — Rename sweep — routes, product id, profile default + scoped migration, eve dir, redirects, tests
  - Surfaced by: plan §9
  - Files: src/app/(workspace)/alfred/* (git mv), products.ts, navigation.ts, agents defaults, eve/alfred/*, next.config.ts
  - Verify: redirect e2e; serialized-identifier audit; migration test with user-chosen name fixture
- [ ] **T6 (P2, human: ~4h / CC: ~30min)** — Decomposition compiler — bounded JSON call, span anchors, review UI, idempotent batch commit
  - Surfaced by: plan §4 invariants
  - Files: knowledge domain, components
  - Verify: double-commit idempotency; invented-quote drop; negation preservation
- [ ] **T7 (P2, human: ~2h / CC: ~20min)** — Cloudflare adapter env wiring — CLOUDFLARE_ACCOUNT_ID/KEY/MODEL, opt-in selection
  - Surfaced by: plan §8
  - Files: src/integrations/generation/cloudflare.ts
  - Verify: selection test (no env → unchanged default chain)
- [ ] **T8 (P2, human: ~1h / CC: ~10min)** — Entry points — collection "New idea" button, nav "Sittings", inbox deep-link repoint
  - Surfaced by: CEO accepted scope items 1-2
  - Files: zettels page, navigation.ts, inbox zettel-generate-button
  - Verify: e2e click-through


### Eng phase (FULL_REVIEW, 2026-10-29)

REALITY: premise-table pass agent_runs execution-substrate premise CORRECTED by eng review: runs route durability lives in the Eve bridge; creation runs execute in-process per §16.1 src/app/api/v1/runs/[runId]/stream/route.ts
REALITY: already-done pass no commits since 2026-10-28 touch knowledge/agents/generation files; migration journal latest 0259 verified 0259_note_comments.sql
REALITY: surface-check pass creation-stream endpoint named; stream route guards verified (eveBridgeUnavailableReason exists and must not be copied) src/app/api/v1/runs/[runId]/stream/route.ts:94
REALITY: binding-decisions pass free-first provider order honored; agent-profile name as machine key documented and now lineage-resolved src/domains/agents/commands.ts:386
REALITY: numbers pass 126 src files with alfred refs [measured]; 5-commit sequencing [estimated]; 1 run-per-sitting cap [estimated] src/lib
REALITY: deferred-asks pass eng smaller corrections (task-write surface, queue detachment) deferred to §10/§16.9 with reasons docs/superpowers/specs/2026-10-29-polymath-zettel-sitting-design.md
REALITY: pr-count pass one combined PR with five-commit internal sequencing per §16.7 docs/superpowers/specs/2026-10-29-polymath-zettel-sitting-design.md

### Gate decision (Phase 4, 2026-10-29, owner reply "I don't want a concept of a sitting")

**DROP THE SITTING LIFECYCLE** — supersedes the sitting lifecycle across §0-§16. uc1 (ended-sitting finality) is moot; d1-d6 accepted as specced.

What this means:
- No "end sitting" action, no ended_at finality, no open/closed states, no ended-sitting read-only records, no ended-deletion-block rules (§15.8 dropped). The sitting workspace is simply always there.
- `zettel_sittings` keeps its rows as a work context (topic, tags, cards join, runs scoping) — but lifecycle columns are inert: no `ended_at` writes, no state machine beyond existence.
- The workspace can be revisited and written to at any time; per-sitting run cap and the §16.9 cleanup rules apply to *active* runs only, not to "closed" sittings.
- UI copy: no "End sitting" button, no closing summary (§14.5 dropped). The sitting list ("Sittings" nav, rail) becomes a simple history of contexts — no status badges.
- Keep: everything else — save-first, allowlist, cursor replay, debounce, decomposition, Bloom, card rail, suggested links.
- §11 tests referencing ended-sitting deletion/confirmation are dropped; replaced by: "ended_at is never written; no end action exists in UI or actions module."

Instinct (builder) should apply this delta in step 5: remove/stub any already-built end-sitting path (endpoint, action, UI button, tests) rather than carrying dead code into the PR.
