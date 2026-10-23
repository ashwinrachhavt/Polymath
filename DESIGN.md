# Polymath Design System

Status: Target design and implementation contract. This document does not certify that described capabilities are implemented.

Precedence: agents/* > CLAUDE.md > this file > skill defaults. Domain behavior belongs to docs/axiom-product-spec.md. Server policy owns authority and tenancy. Resolve contradictions explicitly rather than silently changing domain rules.

Design rationale and component sourcing: https://app.notion.com/p/3fe2e26208a580629dc1d674d23b6f36

## 1. Product and aesthetic

Polymath is a workbench for understanding and acting. Library, Work, and Agents are pillars of one product over one record set. Shorten the path from encounter to capture, understanding, decision, action, and reflection without making that sequence compulsory.

The living notebook direction combines content-first modern software with observation beside interpretation. Warm near-white surfaces, graphite ink, restrained serif authored titles, useful marginal references, and evidence beside writing. No parchment textures, sepia, faux handwriting, brass ornament, graph wallpaper, or decorative AI sparkles. Retain the existing faceted stone mark.

## 2. Shell and layout

One collapsible flat rail, thin header, main canvas, optional inspector. No product switcher, per-app colors, or pill navbar. Primary target groups: Today, Inbox, Library, Work, Agents. Secondary: Review, Stones, Settings. Search and Capture are global actions. Preserve existing destinations, actions, deep links, and route compatibility during migration. Grouping is not permission to remove features.

Reading layouts serve notes and sources. Working layouts serve lists and detail. Observing layouts serve runs and reviews. Do not force all surfaces into dashboard grids. Single-object pages put content first in a readable column. Lists are slim and collapsible. The inspector is closed by default and holds properties, evidence, backlinks, versions, related records, and activity. Opening it preserves position.

Operational canvas maximum: 1200px. Inspector: 360–440px where space permits. Every multi-column component defines its below-768px collapse. Use an accessible sheet or detail route on narrow screens. Mobile target groups: Today, Work, Library, More; Capture remains immediate. Use dynamic viewport units and CSS Grid where appropriate. Breakpoints: 640 / 768 / 1024 / 1280 / 1536. Z-index: base 0, sticky 10, dropdown 20, overlay 30, modal 40, toast 50, skip-link 100.

## 3. Foundations

Preserve the existing warm-neutral light/dark token foundation. Charcoal is the one interface accent. Keep --app-accent aliased to --primary at the root. Semantic state colors always have text or meaningful icons. No feature palette overrides, raw color values in feature components, or Tailwind palette classes for themed surfaces.

Shared semantic roles map to existing theme variables: surface.canvas, surface.page, surface.subtle, text.primary, text.secondary, text.muted, border.subtle, action.primary, state.info, state.attention, state.danger, state.success, reward.stage, reward.halo. Tokens and styles are executable definitions; do not create independently maintained conflicting token tables.

Typography: Inter 13–14px for controls and operational lists; Inter 16px with approximately 1.65 line-height for prose; Inter 12px metadata; Inter 20–24px destination headings; restrained system serif 28–32px authored document titles; Geist Mono and tabular figures for timers, costs, identifiers, and instrument output. Numbers in prose remain prose. Reading measure: approximately 65–75 characters.

Spacing: 4 / 8 / 12 / 16 / 24 / 32 / 48px. Radii: 4 / 6 / 8 / 12px. Full rounding is for chips, avatars, and circular objects, not navigation. Whitespace separates first, borders when necessary, shadows for floating layers only. Avoid nested cards. Retain Lucide during consolidation with shared size and stroke rules.

Prefer CSS transitions, generally 120–200ms, using opacity and transform. Existing animation dependencies do not authorize decoration. No loops, scroll choreography, ambient pulsing, or section entrances. Honor system and in-app reduced motion.

## 4. Object grammar

Source is an immutable artifact with separate extraction and provenance. Note is authored prose. Zettel is the target v1 form of a focused note, not authorization for a second store or schema migration. Claim is an attributed assertion with citation where available and explicit support status. Link is a typed connection with a reason. Task is a commitment with rationale and optional due semantics. Pursuit groups existing records toward an outcome. Session is durable focused work on one task. Stone is a permanent completed-work record. Area is a declared topic. Card is a reviewed retrieval unit. Run is one execution under a policy snapshot. Proposal is a suggested internal or external change awaiting acceptance. Workspace is the server-enforced tenancy boundary.

ObjectInlineLink, ObjectRow, ObjectPreview, ObjectHeader, and ObjectPicker preserve identity, kind, title, destination, and permitted actions. References never confer authorization. Link reasons explain meaning; similarity is not an explanation. Retire Opportunity, duplicate Document stores, separate Lead lifecycles, and streaks. Shards remain an open product decision.

## 5. Reusable components

- CaptureBar: immediate input; saved, duplicate, queued, failed states.
- SourceViewer and CitationAnchor: original versus extraction, exact spans, quotation versus paraphrase.
- ClaimBlock: assertion, attribution, evidence, support status, separately identified estimated confidence.
- NoteEditor: contextual formatting, object links, recovery, save state, versions.
- RelationshipRow: type, target, reason, proposal status.
- ProposalCard and ApprovalPreview: effect, reason, evidence, risk, exact target and content, review.
- TaskRow and PursuitHeader: rationale, optional dates, canonical records, honest lifecycle.
- SessionDock and StoneReceipt: return context, durable timing, outcome, idempotent completion.
- RecallCard and ProgressPair: attempt before reveal, source, effort separate from verified knowledge evidence.
- RunTimeline: observable events, tools, questions, artifacts, cost, policy scope.
- ConnectorStatus, SyncStatus, SurfaceState: honest availability, persistence, and recovery.

Extend existing workspace/ui.tsx and page-header.tsx patterns before inventing. Consolidate incrementally; no third competing kit. Target layers: src/components/ui primitives, src/components/polymath shared domain components, src/features compositions, src/styles foundations. This is not authorization for unrelated moves.

Use cva variants and cn(). No boolean-prop trains, !important, arbitrary z-index, or inline styling where tokens apply. Inspect installed primitives before adding. Use the shadcn CLI and restyle through tokens.

## 6. Behavior contracts

Capture is non-modal and never waits for classification. Saved requires persistence; queued on this device requires a durable local queue. Never infer durability from optimistic UI.

Formatting appears on selection; / inserts blocks; [[ links records. No persistent default writing toolbar. Evidence opens beside writing without losing the draft. Claims without citations are unsupported; accepted is not verified. Do not promise sentence-level AI attribution without preserving it through editing.

No task date means not overdue. Pursuits are views, not second task stores. Sessions derive time from durable timestamps and restore the last thread. Paused and abandoned are neutral. Completion and stone awards are idempotent.

Effort and knowledge evidence are separate, never averaged. Show basis, period, observations, and recency. Accepted claims do not prove recall. Missing measurements are not zero.

Runs show objective, scope, tools, budget, state, observable events, artifacts, and questions. Delegation narrows authority. Events append; terminal states are immutable; retries create new runs. Show observable execution, not private model reasoning.

External writes require reviewed proposals with exact account, target, content, expiry, and expected effect. Approval binds to that effect. Material changes need renewed approval. Unknown outcomes reconcile before retry. Cancel does not promise to reverse completed effects. Communication drafts show their supporting context and never send without explicit approval.

## 7. Stones

Stones are permanent work memories, not points, streaks, ranks, or locked rewards. Small, large, rare remain the tiers. Intensity uses observable duration, sessions, declared difficulty, and resumed abandoned work, never model opinion. Weights remain open.

Keep the existing dark stage and violet halo confined to focus and stone surfaces, including existing .nf-stage and .nf-jewel compatibility. Provide compact, responsive collection, and optional milestone views. The outcome sentence and record work without 3D. Reveals play once, never block, and support reduced motion. No progress decays after absence.

## 8. States, accessibility, and copy

Design loading, empty, filtered empty, ready, partial, stale, offline, error, and denied. Initial loading uses matching skeletons. Mutations show pending and result; external effects add unknown and reconciling. Preserve usable content on refresh. A failure is never an empty list. Empty states offer a real action. No fictional production records; fixtures stay in tests.

Read-your-writes and durable local work are acceptance targets, not unverified implementation claims. Show unsynced and stale state, preserve conflict versions, and never claim offline durability before testing it. Save/sync status is one quiet line.

Target WCAG 2.2 AA. Keyboard operation and drag alternatives, visible focus, predictable overlay focus return, tested contrast and zoom, text equivalents for stones and charts, restrained live regions. Aim for 44px touch targets; meet 24px minimum or applicable spacing exceptions. Labels above inputs, errors below; placeholders are not labels. Imported components require testing.

Use active voice, sentence case, plain verbs, and exact action labels. No em dashes, exclamation marks, filler marketing language, placeholder identities, or unsupported precision in user-visible strings. Explain failures and recovery without guessing.

## 9. Sourcing, acceptance, and debt

Primary primitive source: shadcn/ui. Evaluate editorcn for existing Tiptap compatibility; Plate and BlockNote are alternative stacks, not simultaneous additions. Prompt Kit and current official shadcn AI patterns are selective candidates. Verify exact license, version or commit, accessibility, maintenance, paid boundaries, and attribution before adoption. Candidate status is not dependency approval. Retain Tiptap unless an explicit evaluation justifies migration. UI libraries do not supply Polymath authorization, durability, citation, or reconciliation semantics.

Each shared component documents purpose, product requirement IDs, source/license, variants, states, keyboard/mobile behavior, permissions, events, and tests. Done means domain-state coverage, keyboard/focus checks, narrow-screen behavior, long content, failure/recovery, no fictional records, no duplicate store, and requirement mapping.

Reference workflow: capture article, review classification, write focused note, attach supported claim, link idea, create reasoned task, complete session, record outcome. Extract shared components from a coherent workflow before decorative polish.

Preserve existing migration debt: inspect src/lib/products.ts legacy registry, /apps/* preview tools, and app-era copy before retiring them. navigation.ts remains the navigation implementation to reconcile. Do not delete these solely because this document names them.

Open decisions: distinct zettel entity if justified; stone intensity weights; shards; milestone assets; agent tool grants; measured narrow-screen density; candidate components after checks.
