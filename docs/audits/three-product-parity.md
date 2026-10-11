# Three-product UI parity decision index

This index contains all **694 keep/merge/drop decisions** across the three donors. No audit rows were removed. The [CSV index](three-product-parity.csv) maps every row to its full original status, controls, rationale, source evidence, preview coverage and gaps in the complete CSV parts below. The original unabridged single-file CSV and Markdown are delivered separately; the repository uses parts to fit the connected-account upload limit.

## Complete evidence parts

- [part-001.csv](parity-parts/part-001.csv) — 59 complete records
- [part-002.csv](parity-parts/part-002.csv) — 98 complete records
- [part-003.csv](parity-parts/part-003.csv) — 103 complete records
- [part-004.csv](parity-parts/part-004.csv) — 100 complete records
- [part-005.csv](parity-parts/part-005.csv) — 107 complete records
- [part-006.csv](parity-parts/part-006.csv) — 97 complete records
- [part-007.csv](parity-parts/part-007.csv) — 82 complete records
- [part-008.csv](parity-parts/part-008.csv) — 48 complete records

Combine the parts in numeric order, retaining the header only from the first part, to recover the original full CSV. Each part uses the identical 21-column schema.

## Cross-product feature decisions

| ID | Feature | Decision | Target | Full status, rationale and evidence |
|---|---|---|---|---|
| A01 | Daily Briefing | KEEP | /apps/command-center/briefing | [Complete row](parity-parts/part-001.csv) |
| A02 | Quick Capture | MERGE | /apps/command-center/inbox | [Complete row](parity-parts/part-001.csv) |
| A03 | Tasks & Commitments | MERGE | /apps/neuralflow/tasks | [Complete row](parity-parts/part-001.csv) |
| A04 | Kanban | KEEP | /apps/neuralflow/boards | [Complete row](parity-parts/part-001.csv) |
| A05 | Spaces vs Projects | MERGE | /apps/neuralflow/projects | [Complete row](parity-parts/part-001.csv) |
| A06 | AI Planning / Brain Dump | KEEP | /apps/neuralflow/brain-dump | [Complete row](parity-parts/part-001.csv) |
| A07 | Card Micro-Actions | KEEP | /apps/neuralflow/tasks | [Complete row](parity-parts/part-001.csv) |
| A08 | Calendar | MERGE | /apps/neuralflow/calendar | [Complete row](parity-parts/part-001.csv) |
| A09 | Pomodoro / Focus | KEEP | /apps/neuralflow/focus | [Complete row](parity-parts/part-001.csv) |
| A10 | Stones / Shards | KEEP | /apps/neuralflow/rewards | [Complete row](parity-parts/part-001.csv) |
| B01 | Document Intake / Vault | MERGE | /apps/command-center/documents | [Complete row](parity-parts/part-001.csv) |
| B02 | Classification / Rename | KEEP | /apps/command-center/documents | [Complete row](parity-parts/part-001.csv) |
| B03 | Profile Facts | KEEP | /apps/command-center/applications | [Complete row](parity-parts/part-001.csv) |
| B04 | Rich Notes | MERGE | /apps/alfred/notebook | [Complete row](parity-parts/part-001.csv) |
| B05 | Zettels | KEEP | /apps/alfred/zettels | [Complete row](parity-parts/part-001.csv) |
| B06 | Dossiers | KEEP | /apps/alfred/dossiers | [Complete row](parity-parts/part-001.csv) |
| B07 | Studio | KEEP | /apps/alfred/studio | [Complete row](parity-parts/part-001.csv) |
| B08 | Deep Research | MERGE | /apps/alfred/research | [Complete row](parity-parts/part-001.csv) |
| B09 | Dictionary | KEEP | /apps/alfred/dictionary | [Complete row](parity-parts/part-001.csv) |
| B10 | Canvas | KEEP | /apps/alfred/canvas | [Complete row](parity-parts/part-001.csv) |
| B11 | Learning | MERGE | /apps/alfred/learning | [Complete row](parity-parts/part-001.csv) |
| C01 | Contacts / Companies | KEEP | /apps/command-center/contacts | [Complete row](parity-parts/part-001.csv) |
| C02 | Opportunities / Leads | KEEP | /apps/command-center/opportunities | [Complete row](parity-parts/part-001.csv) |
| C03 | Outreach / Email | KEEP | /apps/command-center/contacts | [Complete row](parity-parts/part-001.csv) |
| C04 | Reviews | KEEP | /apps/command-center/reviews | [Complete row](parity-parts/part-001.csv) |
| C05 | Browser Companion | MERGE | /apps/command-center/companion | [Complete row](parity-parts/part-001.csv) |
| C06 | Spending | KEEP | /apps/command-center/spending | [Complete row](parity-parts/part-001.csv) |
| D01 | AppSwitcher / shared responsive shell | MERGE | /apps/command-center/briefing | [Complete row](parity-parts/part-001.csv) |
| D02 | Universal command palette / keyboard help | MERGE | /apps/command-center/inbox | [Complete row](parity-parts/part-001.csv) |
| D03 | Inspectors / exact-version deep links | MERGE | /apps/neuralflow/tasks | [Complete row](parity-parts/part-001.csv) |
| D04 | Conversations / checkpoints | MERGE | /apps/command-center/conversations | [Complete row](parity-parts/part-001.csv) |
| D05 | Agents / run events / tools / artifacts | MERGE | /apps/command-center/agents | [Complete row](parity-parts/part-001.csv) |
| D06 | Agent questions / safe-point instructions | KEEP | /apps/command-center/agents | [Complete row](parity-parts/part-001.csv) |
| D07 | Models / profile / tool policy | MERGE | /apps/command-center/agents | [Complete row](parity-parts/part-001.csv) |
| D08 | Reviewed memory | KEEP | /apps/command-center/memory | [Complete row](parity-parts/part-001.csv) |
| D09 | Connector setup / account identity / sync | MERGE | /apps/command-center/integrations | [Complete row](parity-parts/part-001.csv) |
| D10 | Blog studio / reviewed publication | KEEP | /apps/alfred/blogs | [Complete row](parity-parts/part-001.csv) |
| D11 | Wiki links / backlinks / relation editing | MERGE | /apps/alfred/notebook | [Complete row](parity-parts/part-001.csv) |
| D12 | Application tracker / requirements / materials | KEEP | /apps/command-center/applications | [Complete row](parity-parts/part-001.csv) |
| D13 | Form preparation / per-field replacement / files | KEEP | /apps/command-center/companion | [Complete row](parity-parts/part-001.csv) |
| D14 | Delivery timing / cadence / uncertain reconciliation | KEEP | /apps/command-center/reviews | [Complete row](parity-parts/part-001.csv) |
| D15 | Weekly reports / notifications / activity | MERGE | /apps/neuralflow/reports | [Complete row](parity-parts/part-001.csv) |
| D16 | Scheduler / availability preferences | KEEP | /apps/neuralflow/scheduler | [Complete row](parity-parts/part-001.csv) |
| D17 | Meetings / linked notes / action items | MERGE | /apps/neuralflow/meetings | [Complete row](parity-parts/part-001.csv) |
| D18 | Reading / source library / engagement | KEEP | /apps/alfred/library | [Complete row](parity-parts/part-001.csv) |
| D19 | Knowledge graph / hybrid search | MERGE | /apps/alfred/graph | [Complete row](parity-parts/part-001.csv) |
| D20 | Dictionary annotations / multisense concept model | MERGE | /apps/alfred/dictionary | [Complete row](parity-parts/part-001.csv) |
| D21 | Reusable prompts / runtime configuration | MERGE | /apps/command-center/agents | [Complete row](parity-parts/part-001.csv) |
| D22 | Sittings / decomposition / working sessions | MERGE | /apps/alfred/notebook | [Complete row](parity-parts/part-001.csv) |
| D23 | Settings / appearance / accessibility | MERGE | /apps/command-center/settings | [Complete row](parity-parts/part-001.csv) |
| D24 | Machine clients / one-time credentials | KEEP | /apps/command-center/settings | [Complete row](parity-parts/part-001.csv) |
| D25 | PDF / document export / pinned attachments | MERGE | /apps/command-center/documents | [Complete row](parity-parts/part-001.csv) |
| D26 | Owner / auth / mutation / migration contracts | MERGE | /apps/command-center/settings | [Complete row](parity-parts/part-001.csv) |
| D27 | Debug / dead / developer references | DROP | /apps/command-center/settings | [Complete row](parity-parts/part-001.csv) |

## Original audit boundaries and narrative

# Three-product UI parity matrix

**Source-backed decision matrix — 2026-10-11. Not production-parity certification.**

This is the owner-requested cross-product keep/merge/drop matrix, including **all original A Execution, B Knowledge and C CRM / Infra categories**, discovered features, every donor inventory table data row (routes, detailed component/affordance groups, references and mockups), and supplemental narrative-only controls/safety defects. No top-N selection is applied. A component/control group may contain several explicit controls in one row; the full inventories remain the exhaustive component evidence annexes, not replaced by this decision index. CSV contains the same per-row decisions, rationale, product statuses, target routes/components, preview status and full evidence.

## Boundaries and how to use this matrix

- **One Next.js application**, three presentation lenses at `/apps/command-center`, `/apps/neuralflow`, `/apps/alfred`. Canonical Neon Postgres/pgvector and shared Clerk are **future production foundations**, presently unconfigured. Shared AppSwitcher, Cmd+K, capture, Reviews and identity span lenses. No donor federation, app iframes, permanent proxy or copied FastAPI/Celery/Qdrant/Prisma services. A sandboxed saved-email preview is a content-safety technique, not an iframe product architecture.
- **KEEP** retains useful behavior/invariants in a feature-specific view, reimplemented safely; it does not approve copying defective donor code. **MERGE** retains interactions within canonical objects/shared workflows; it does not delete owner-requested product screens. **DROP** excludes an unsafe/no-op/dead/duplicate/debug/unsupported path; underlying useful data or repaired capability may still be retained. These are per-row decisions, not implementation completion.
- **Donor status is static source evidence**, not current browser-tested success. CC inventory `I` means mounted component/handler, `B` means backend/provider/worker required, `P` means planned/link-only/absent. NF inventory `I` means mounted/wired, `P` materially partial, `B` broken/no-op, `U` unmounted, `A` aspiration/schema/API/mockup-only. Alfred uses explicit mounted/backend-only/dormant/inert/planned descriptions. These legends are **not interchangeable**; original source descriptions are retained below and in CSV.
- Feature rows compare products directly. Donor-specific detail rows identify that product's exact status; other product cells say **Related family only** and reference the feature row. That is not an assertion that another donor supplies the identical control. A schema/API or primitive definition is never counted as a usable screen.
- **Current Axiom coverage: partial/preview only.** `/workspace/repos/axiom/src/lib/products.ts:6-64` registers destinations and prior Axiom aliases; registration is not component completeness; source mount/control definitions and provider readiness are separate columns. All46 registered product destinations now have source-dispatched preview screens (CC19/NF12/Alfred15). Finished entry components and representative finished control groups were read only to establish coverage, **not audited for correctness**; concurrent CC composer/memory/rate-card expansion is not reviewed here. The coordinator reports46 route smoke checks (HTTP200, one h1, active nav, no browser JS errors) and shared capture persistence across reload/product views. **This is route smoke, not donor-control or accessibility certification.** Broader keyboard/hydration/streaming-status checks and final validation are handled separately by main in `docs/audits/ui-validation.md`; this matrix does not claim those checks passed. All AI, extraction, sync, external writes, companion runtime, budgets, production auth and Neon persistence remain **unconfigured**. Local/sample previews and local review decisions are not real provider execution or production data.
- Target component names below are **implementation contracts**, not claims that a named component is finished or currently mounted. Each row's Axiom evidence is recorded in CSV: registry, spec three-product update and source-revisions boundary. Coverage cells now identify **source-defined local preview control groups** and their explicit remaining gaps. Do not upgrade coverage merely because a concurrent component file appeared or a route returned200.
- Architecture/migration tickets: **ASH-104** shared shell; **ASH-105** canonical migrations/no orphan or duplicate tables; **ASH-112** AI SDK plus durable adapter, not wholesale donor Celery/LangGraph runtime retention. Production definition of done still requires schema/mutation ownership, tenant/version/idempotency/audit tests, reconciled imports, restart/duplicate-delivery durability, UNKNOWN reconciliation and accessible recovery/state coverage.

## Provenance

The coordinator verified exact requested SHAs through the GitHub commits API and retrieved exact-SHA tarballs. There is **no local `.git`**, so this is not a local HEAD attestation. See `/workspace/repos/axiom/docs/audits/source-revisions.json:1-13`.


Canonical authority: `/workspace/repos/axiom/docs/axiom-product-spec.md:62-66,83-169,171-240,281-313`; `/workspace/repos/axiom/docs/axiom-nextjs-neon-plan.md` (modular monolith, canonical schema, workflow and release gates); `/workspace/repos/axiom/agents/{product,engineering,design}.md`. The earlier iframe/federation spec is superseded. Inventory quotes mentioning old flat IA or historical delivery remain audit history, not override of the current three-product presentation update.

## Important claim corrections

1. **NeuralFlow Learning is mostly schema/API and unmounted reflection, not a mounted learning suite.** No standalone flashcard review/quiz-taking screen; quiz endpoint removed. Alfred supplies real due-review/Feynman controls, but its quiz adapter is also empty. See B11, NF rows and annex `/workspace/repos/axiom/docs/audits/neuralflow-ui-inventory.md:271-289`.
2. **NeuralFlow focus lifecycle is not durable in the donor.** Mounted timer uses local countdown state, loses navigation/reload state and has no completed-session/reward write; Alfred local focus IDs and retrospective +Pomodoro are not a durable timer either. Durable lifecycle is Axiom target (A09), not established donor parity.
3. **Alfred graph is statically broken.** Missing `use-zettel-graph` reaches shell prefetch; missing graph/Galaxy modules are source-resolution blockers. No build was run to reproduce it. NeuralFlow's random-PCA raw-vector view is unmounted and has no graph edges. See D19 and `/workspace/repos/axiom/docs/audits/alfred-ui-inventory.md:179-183`.
4. **Alfred project management UI does not exist.** Projects are backend-only; a read-only project number and source-scoped Dossiers do not establish `/projects` or a project-detail/board screen. NeuralFlow has assignment/create controls, not a full manager. Canonical Axiom Projects is new target UI (A05).
5. **CC Reviews/spend are substantial but not defect-free.** Exact receipts/revision controls are retained; unknown responses, attachment drift, paused-policy reactivation and invented unlisted model rates are explicitly excluded. A universal kill switch is a production target, not donor-delivered UI.
6. **NF migration constraints are real, not separate task universes.** `Task.boardId`/`columnId` are required and `Note.taskId` unique 1:1 (`/workspace/donors/neuralflow/prisma/schema.prisma:122-127,192-205`, annex `:145,175-178`). Map board ownership, column/status and notes explicitly; canonical Axiom tasks must not become board-owned duplicates. NF `Embedding.embedding` is JSON (`schema.prisma:310-320`, annex `:287-288`), not a typed pgvector1536 column. Version/model/dimension-validate and re-embed into the selected canonical vector model; do not blindly coerce JSON into `vector(1536)` or claim existing vectors already compatible.

## Feature-level cross-product decisions


## Detailed route, component, control and reference decisions

Every source table data row is included below. Reference/mockup rows are explicitly not mounted-screen proof. Narrative-only controls and exclusions follow them. Complete source wording remains in controls/status/rationale; exhaustive module names and handler caveats stay in the linked donor annexes. Full source citation strings are also available in the CSV evidence columns.

### Command Center — 164 source rows


### NeuralFlow — 240 source rows


### Alfred — 202 source rows


### Narrative-only affordances and explicit defects


## Explicit drop / repair-before-parity list

These are excluded from production parity; **DROP does not mean silently discarding historic records or the underlying safe feature**.


## Acceptance and coverage ledger


**Coverage snapshot addendum:** Sources read include finished CC dispatcher/Reviews/Documents/Agents/Companion, NF work/calendar/focus/reflection/workspace components, Alfred dispatcher/Notebook/rich editor/Dossiers/Dictionary/Learning/Blog/Canvas/Excalidraw, route entries and shared browser preview store. Other screens remain dispatcher-level coverage rather than invented exact control completion. Browser reports belong to the coordinating session, not this static matrix task.

**Matrix reconciliation:** 694 rows: 54 feature-level, 164 Command Center source-table rows, 240 NeuralFlow source-table rows, 202 Alfred source-table rows and 34 narrative supplement rows. Layer counts: affordance=485, exclusion=17, feature=54, reference=52, route=86. Decisions: DROP=67, KEEP=198, MERGE=429. These counts are matrix groups, not feature completion or unique React symbols. CSV row IDs are unique; all 27 original user categories A01–A10/B01–B11/C01–C06 remain individually represented.

