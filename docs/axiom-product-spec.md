# Axiom Product Specification

**Status:** Proposed for implementation  
**Date:** 2026-10-10  
**Product:** Axiom — personal command center and knowledge operating system  
**Primary user:** A single owner in v1; tenant-ready by design

## Product decision

Axiom is a coherent new product, not an iframe shell or permanent federation of donor backends. It consolidates Command Center's operational safety with NeuralFlow's planning, focus, learning, and gamification into one Next.js 16 application and one Neon Postgres system of record.

> **Axiom converts everything entering a person's world into an ordered, trustworthy plan; keeps knowledge connected; and lets supervised AI agents do useful work without quietly taking control.**

The primary loop is **Capture → Clarify → Commit → Focus → Review → Learn**.

## Goals

- Provide one daily cockpit across tasks, calendar, communications, projects, opportunities, relationships, and knowledge.
- Reduce executive-function load by identifying what deserves attention, explaining why, and exposing the safest next action.
- Preserve provenance and reversibility for agent output, external actions, imports, derived knowledge, and edits.
- Turn completed work into learning through notes, retrieval, flashcards, reflection, and weekly review.
- Make Gmail, Google Calendar, Drive, Notion, GitHub, Linear, Vercel, Composio, and Firecrawl feel like native Axiom capabilities.
- Remain viable on free plans for personal use while defining explicit paid-upgrade thresholds.

## Non-goals

- A general-purpose team collaboration suite in v1.
- Reproducing every donor experiment as a top-level destination.
- Autonomous sending, publishing, deployment, application submission, or destructive mutation without deterministic policy and approval.
- Maintaining FastAPI/Celery and Prisma implementations after parity.
- Arbitrary user-authored code execution or unbounded browser automation.
- Pixel-preserving donor interfaces.

## Users

### The Commander

The owner needs Axiom to answer:

1. What matters now?
2. What am I waiting for or at risk of dropping?
3. What can Alfred safely prepare or execute?
4. What do I know about this person, project, or decision?
5. What did I accomplish and learn?

### Alfred

Alfred is a supervised chief-of-staff agent with an identity, instructions, model policy, tool allowlist, budget, memory policy, and observable run history. Alfred researches and drafts by default. Consequential external mutations pass through Reviews unless a narrowly bounded policy permits execution.

## Principles

- **Briefing before browsing:** home is a decision surface, not analytics wallpaper.
- **Objects before pages:** tasks, projects, people, documents, events, messages, and runs have canonical representations.
- **One record, many views:** list, board, calendar, focus, and briefing share one task model.
- **AI proposes; policy disposes:** model output never overrides deterministic authorization.
- **Progressive disclosure:** defaults are calm; evidence, lineage, cost, revisions, and provider payloads remain accessible.
- **No invisible work:** long jobs expose progress, questions, cancellation, retries, artifacts, and spend.
- **Learning follows completion:** reflection should enrich completed work without obstructing it.

## The suite

Axiom is a unified platform with **three micro-app experiences** over one
canonical system of record. Each app has its own contextual navigation and
feature ownership; all three read and write the same records and share the same
platform services.

> A task prepared from a Command Center meeting appears in NeuralFlow without
> being copied. Its supporting note opens in Alfred without being reimported.
> The suite is a way of exposing the product, not three products.

These are product boundaries, not deployment boundaries. There is one Postgres
system of record, one identity provider, one agent runtime, one approval
pipeline, and one spending ledger. A three-app interface does not require three
databases.

| App | Primary question | Owns |
|---|---|---|
| Command Center | What is happening, what do I owe, and what needs action? | Briefing, inbox and capture, relationships, opportunities, correspondence, reviews of external action |
| NeuralFlow | What should I work on, and how do I make progress? | Work in list/board/calendar modes, projects and spaces, planning, focus sessions, weekly review, rewards |
| Alfred | What do I know, and what can I produce? | Threads and runs, knowledge and notes, dossiers and research, documents, learning |

Three concerns are **shared, not owned**: Reviews (approve actions and agent
output), Activity (audit), and Settings (identity, connectors, models, policies,
budgets). Every app links into them from its own context.

### Routes

```text
/command-center/{briefing,inbox,relationships,opportunities}
/neuralflow/{work,focus}
/alfred/{,knowledge,dossiers}
/reviews  /activity  /settings          shared, unprefixed
```

The app segment is in the URL. That is what makes the boundary checkable rather
than a naming convention, and it is what lets the breadcrumb name the app the
owner crossed into.

### Navigation

The model is Google Workspace's, not a switcher welded into a nav rail. What
each app sees is its own chrome plus one shared control.

- **The app launcher** lives in the global header and is the only global
  chrome. It lists the three apps and the cross-app links out of the current
  one. It is not part of any app's navigation.
- **Each app owns its own nav bar**, and its shape is the app's personality
  expressed as structure:
  - Command Center: a full-height lateral **rail**. An operations desk keeps
    its sections in view because you move between them constantly.
  - NeuralFlow and Alfred: a horizontal **bar** under the header. These are
    places you read and work in, and a rail would take width from the material.
- **A shared control means a shared accent.** Primary actions and the active
  rule use `--app-accent`, scoped by a `data-app` attribute the shell sets, so
  "New note" is violet in Alfred, green in NeuralFlow, cyan in Command Center
  without any component knowing which app it is in. On shared routes (Reviews,
  Activity, Settings, auth) the token falls back to the product's cyan, which is
  also Command Center's. **The ground, type, radii, and edges stay identical
  across all three**: the apps are three modes of one instrument, not three
  products, and an app that also changed its weight or spacing would make the
  suite look assembled from parts.
- **Mobile bottom bar:** the apps themselves, then More. A phone cannot carry an
  app's nav bar and the launcher in one 44px strip, and the launcher is the one
  that has to survive — losing it would strand the owner inside one app. Within
  an app, sections are reached from the app's home or from More, which lists
  every destination grouped by app.
- `⌘K` reaches everything from anywhere, including across apps. *(Lands with
  the command palette; until then the header search button marks the spot it
  will occupy.)*

### Interoperability

The apps are separate surfaces over one record set, so crossing between them has
to be a first-class move rather than a copy. Two mechanisms, and they are
different:

- **The launcher's cross-app links.** Declared in one table
  (`crossAppLinks`), each names what the owner is doing and opens the *other*
  app at the record class that continues the work — "Turn into work", "Notes in
  Alfred". Because both endpoints are declared, the link out and the ability to
  name where you came from are the same data.
- **Record-level links inside a screen.** A task shown in Command Center opens
  in NeuralFlow *at that task*, not at NeuralFlow's home. This is the load-bearing
  one: the launcher's links are navigation, and only record-level links make the
  suite feel like one product.

There is no "equivalent screen" mapping between apps. Alfred's Knowledge is not
Command Center's Inbox under another name, and inventing that mapping would be a
lie the navigation then has to maintain.

### Record placement

Feature ownership above says which app *presents* a capability, not which app
owns the row. Concretely:

- Notes belong to Alfred. NeuralFlow's task reflections are artifacts rendered
  under Work, not a second note universe.
- Boards are saved view configurations over the one task model. They never own
  duplicate tasks.
- Spaces (Command Center grouping and context) and projects (NeuralFlow,
  outcome-carrying) and dossiers (Alfred, bounded source sets) are three
  distinct objects that link to each other. They are not synonyms.
- Focus sessions and Pomodoro sessions are one session model with explicit
  timing modes and segments, not two.

### Standing tensions

Two conflicts between the app structure and the shared-record rule, resolved as
follows so they are not re-litigated per screen:

- **Work spans apps.** Tasks are created in Command Center (a meeting becomes a
  task) and executed in NeuralFlow. Command Center owns *the route in*, not a
  second task screen. Any Command Center screen that shows a task links into
  NeuralFlow at that record.
- **Dossiers versus Knowledge.** Research and general knowledge are close
  neighbours, and the roster will drift if the distinction is soft. Dossiers are
  bounded: a chosen set of sources with cited answers. Knowledge is unbounded
  capture and retrieval. A dossier that stops being bounded is a note.

### Progressive disclosure

The launcher exists from the first release; the third app does not have to. Both
Alfred and NeuralFlow are present in the spec, but a build order may ship
Command Center first and let the launcher carry two entries. An app appears when
it has a capability, not when its navigation exists.

Because the launcher is the only global chrome, adding an app costs one entry in
`apps` plus that app's own nav — no other app's chrome changes. That is the
property worth protecting: a fourth surface should not require editing the three
that exist.

## Global command layer

`⌘K` provides universal search, creation, navigation, and safe delegation. Persistent capture accepts text, URL, file, voice transcript, or forwarded content. Search combines structured fields, full text, and semantic retrieval while retaining source and version filters.

## Core journeys

### Morning briefing

1. Assemble a local-day briefing without calling an LLM on initial load.
2. Recommend three outcomes using deadlines, dependencies, calendar fit, value, and prior commitments.
3. Let the owner accept, edit, or replace outcomes.
4. Display calendar, workload, waiting items, reviews, questions, and recent completion.
5. Start Focus or ask Alfred for a bounded plan.

Acceptance criteria:

- Useful without AI providers.
- Calendar and inbox synchronization state is visible.
- No silent status or schedule mutation.
- Keyboard-only operation works.

### Capture and triage

1. Capture enters Inbox as `UNPROCESSED` with immutable source payload.
2. Rules classify obvious files, URLs, events, and messages; Alfred enriches asynchronously.
3. User converts to task, note, project, contact, opportunity, reference, or trash.
4. Conversion is transactional and preserves lineage.

Acceptance criteria:

- Fast capture, asynchronous enrichment.
- Duplicate provider IDs, message IDs, and URLs detected.
- Original material preserved after derived records change.

### Work and focus

- Work defaults to Today with list, board, and calendar presentations.
- Dragging performs optimistic, version-checked rank or status changes.
- Starting Focus creates a durable session tied to one task.
- Completion offers lightweight outcome, learning, follow-up, and reward capture.
- Timer state survives navigation and refresh.
- Rewards are idempotent.

### Delegate to Alfred

1. Choose a record or thread and provide an objective.
2. Display active profile, relevant context, model, expected tools, and budget.
3. Stream durable run events and tool activity.
4. Pause on missing information through a durable question.
5. Convert external writes into action proposals.
6. Support approve, reject, edit, retry, cancel, checkpoint, and branch.

Agent states:

`QUEUED → RUNNING → WAITING_INPUT | WAITING_APPROVAL | SUCCEEDED | FAILED | CANCELLED`

Run invariants:

- Terminal states are immutable; retries create new runs.
- Tool results are append-only.
- Tools cannot escape the captured policy snapshot.
- Spending is reserved before paid work and settled afterward.
- Reload reconstructs the timeline from durable events.

### Knowledge loop

- Notes and documents link to any Axiom object.
- Imports preserve original blobs, extracted text, source metadata, classification, and immutable versions.
- Search combines exact, full-text, and semantic retrieval.
- Alfred suggests summaries, claims, flashcards, and links for review.
- Every generated claim can reference source spans.
- Re-embedding is versioned and does not change document identity.

### Connected action

1. Connect and label accounts such as `work-gmail` and `personal-github`.
2. Store provider/Composio identifiers and redacted metadata, never OAuth secrets.
3. Resolve tools from feature-specific allowlists and explicit accounts.
4. Create action proposals with preview, risk, dedupe key, expiration, and expected effect.
5. Record execution attempt, provider response summary, and reconciliation state.

Acceptance criteria:

- Provider secrets never reach the browser.
- Webhooks are signature-verified and deduplicated.
- Replaying a proposal cannot repeat its side effect.
- Uncertain outcomes become `UNKNOWN` and reconcile before retry.

## Feature requirements

### Briefing and planning

- Daily outcomes, quick capture, agenda, task queue, waiting queue, reviews, questions, running work, outputs, and sync health.
- Explainable priority reasons and user-controlled ranking.
- Timezone-aware planning and weekly review.
- Scheduler suggestions propose rather than silently rewrite time.

### Work management

- Projects, spaces, tasks, subtasks, dependencies, priorities, statuses, dates, estimates, tags, assignees, attachments, recurrence, snooze, archive, bulk edit, undo, and record links.
- List, board, calendar, and focus views over one task model.
- NeuralFlow boards become saved views and ordered columns, not a second task universe.

### Alfred and agents

- Profiles, threads, messages, checkpoints, runs, steps, questions, tools, artifacts, memory links, model routing, spending, cancellation, retries, and event streaming.
- First-party Alfred profile with constrained Axiom and external tools.
- Durable research, import, classification, correspondence, and application workflows.
- Reviewed memory; no automatic durable memory from raw model output.

### Reviews and approvals

Unified queue for email, calendar, Notion, GitHub, Linear, Vercel, publishing, destructive edits, and browser steps.

| Risk | Examples | Default |
|---|---|---|
| Read | Search mail, read issue, fetch page | Execute within scoped connection |
| Prepare | Draft email, compose issue, create local artifact | Execute locally |
| External write | Send email, create event, update issue | Human approval |
| Sensitive write | Delete, submit, post publicly, merge/deploy | Approval plus confirmation |
| Prohibited | Export credentials, bypass policy | Deny |

### Knowledge and documents

- Rich notes with working drafts, checkpoints, recovery, versions, backlinks, tags, and linked tasks.
- File upload and Drive import; extraction, type review, classification, renaming, sources, spans, and derivations.
- Postgres full-text plus pgvector hybrid search.
- Summaries, quizzes, flashcards, review scheduling, graph edges, and PDF export.

### Relationships

- Contacts, companies, observations, evidence, relationship status, correspondence, follow-ups, research, deduplication, and reversible CSV import.
- Gmail drafting and delivery through Reviews.

### Opportunities

- Generic opportunities with optional job/application specialization.
- Source capture, company and role identity, stages, form snapshots, resume/cover-letter selection, keyword analysis, materials, and versions.
- Browser companion is an explicit paired client, never a hidden server capability.

### Learning and rewards

- Focus sessions, streaks, weekly report, learning notes, flashcards, quizzes, and small collectibles.
- Rewards reinforce completion and review without obscuring productivity.
- Reduced-motion and disable-celebration settings.

## Integration scope

| Integration | Reads | Writes | Triggers |
|---|---|---|---|
| Gmail | threads, messages, labels, profile | draft, send, label | new message, reply |
| Google Calendar | calendars, events, free/busy | create, update, delete | event changes |
| Google Drive | search, list, metadata, content | upload, move, share | file changes |
| Notion | pages and databases | create and update | page/database changes |
| GitHub | repos, files, issues, PRs, checks | issues, PRs, comments, branches | pushes, issues, PRs |
| Linear | teams, projects, issues, comments | create, update, comment | issue state changes |
| Vercel | projects, deployments, logs | deploy, redeploy, cancel under strict policy | deployment changes |
| Firecrawl | search, scrape, map, crawl | no external mutation | crawl completion |

## Frontend and design

### Direction

A **quiet command-room** aesthetic: warm neutral light mode, graphite dark mode, restrained cyan/teal accent, strong reading typography, and high information density without cramped controls. Avoid repeated border-box nesting and large empty dark surfaces.

### Shell

- Desktop: 248 px collapsible navigation rail, flexible canvas, optional 360–440 px inspector.
- Tablet: icon rail and overlay inspector.
- Mobile: bottom navigation for Briefing, Inbox, Work, Alfred, and More.
- Header: breadcrumb, view controls, sync, search, capture, review count, account.
- Inspector: details, backlinks, activity, Alfred context, and actions without losing list position.

### Design tokens

- 4 px spacing base; common gaps 8/12/16/24/32.
- Body 14–16 px; metadata at least 12 px.
- Radius: 8 px controls, 12 px cards, 16 px major surfaces.
- Borders establish structure; shadows indicate actual elevation.
- Color is never the sole status signal.
- Direct motion 120–200 ms and reduced-motion support.

### Components

`AppShell`, `NavRail`, `CommandPalette`, `QuickCapture`, `PageHeader`, `ViewSwitcher`, `FilterBar`, `DataTable`, `KanbanBoard`, `CalendarCanvas`, `Timeline`, `Inspector`, `TaskRow`, `OutcomeCard`, `ReviewCard`, `RunCard`, `EvidenceCard`, `Composer`, `Conversation`, `ToolCall`, `Checkpoint`, `AgentQuestion`, `RichEditor`, `DocumentViewer`, `SourceSpan`, `VersionHistory`, `EmptyState`, `Skeleton`, `ErrorBoundary`, `OfflineBanner`, `SyncBadge`.

### States and accessibility

Every feature defines loading, empty, partial, stale, error, offline, permission-denied, and success states. Target WCAG 2.2 AA, complete keyboard operation, visible focus, keyboard alternatives to drag-and-drop, stable focus order, text equivalents for charts/rewards, and restrained live regions for timers/streaming.

### Performance budgets

- Initial route JavaScript target under 180 KB gzip excluding shared runtime.
- LCP under 2.5 seconds at p75.
- INP under 200 ms at p75 for ordinary edits.
- One server composition boundary for Briefing.
- Virtualize above 200 visible rows and paginate all server collections.

## Data and safety contracts

- Every owned table contains `workspace_id`.
- Server resolves owner from Clerk; clients never select owner IDs.
- Mutations require an idempotency UUID.
- Mutable rows carry integer versions and reject stale writes.
- Important changes write audit events transactionally.
- External side effects pass through proposals and attempts.
- Unknown provider outcomes reconcile before retry.
- Neon stores metadata, extracted text, hashes, and lineage; object storage holds binaries.

## Success measures

Activation requires connecting calendar/inbox, capturing five items, accepting an outcome, completing a focus session, and deciding one Alfred proposal.

Operational measures include briefing use, accepted-outcome completion, capture-to-clarification time, focus completion, review age, agent run success/retry/edit rates, search success, and knowledge reuse.

Guardrails:

- Zero duplicate external effects.
- Zero cross-workspace leaks.
- Zero writes without valid policy/approval.
- Zero spend above captured budget.
- Zero unresolved `UNKNOWN` actions older than 24 hours.

## Release plan

1. **Foundation:** identity, tenancy, shell, database, audit/idempotency, connectors, webhook inbox, observability.
2. **Daily loop:** Briefing, Inbox, tasks/projects/spaces, board/calendar, focus, quick capture, weekly review.
3. **Alfred:** threads, durable runs, AI SDK, Firecrawl, questions, artifacts, budgets.
4. **Connected execution:** Composio, provider adapters, Reviews, proposals, attempts, scheduling, reconciliation.
5. **Knowledge and opportunities:** notes, documents, extraction, hybrid search, learning, CRM, applications, companion.
6. **Migration and retirement:** dry runs, reconciliation, cutover, donor freeze, archive.

## Open decisions

- Obtain and inventory the Alfred/Eve donor repository.
- Confirm whether Eve is a workflow runtime, second persona, or external service.
- Select production object storage.
- Define which low-risk writes may eventually auto-execute.
- Decide when multi-user collaboration graduates beyond schema readiness.
