# Polymath Product Specification

**Revision:** 2026-10-19. Supersedes the job-search framing entirely.
**Canonical copy:** Notion, under Command Center / Polymath.
**Source of decisions:** the Notion Decision Log, rounds 1 to 4.

This file is the repo-side copy, reviewed in PRs. Behaviour is owned by the
Notion page; when the two disagree, say so in the PR rather than silently
picking one.

> **Naming.** The product is Polymath. The repository, package, and docs were
> renamed from Axiom in `d9bd844`. This file keeps its old prefix so existing
> links resolve.

## 1. What Polymath is

A workspace for people whose work is thinking. It turns everything entering one
person's world — mail, files, pages, ideas, roles — into an ordered, trustworthy
plan; keeps knowledge connected and retrievable; and lets supervised agents do
the work without quietly taking control.

Knowledge workers lose their best work to four things:

- **Menial work crowds out creative work.** Extraction, parsing, copying,
  re-entry.
- **Notes are written and never revisited.** A library nobody can search is a
  cost, not an asset.
- **Focus drifts.** Nothing separates deep work from shallow work.
- **Effort is invisible.** Hard work finishes with no acknowledgement and no
  signal about whether knowledge grew.

The goal is that a person's accumulated knowledge becomes their most valuable
asset: a map of the world, stored well, retrievable, usable by the person and by
their agents.

## 2. Who it is for

The ideal user works largely alone, produces written or analysed output, reads
more than they write, keeps notes somewhere they do not revisit, uses LLMs
daily, and carries recurring obligations with deadlines.

| Persona | Work | Primary value |
|---|---|---|
| Generalist operator | Engineering, product, writing, job search | Capture, connect, produce |
| Professional-services principal | Accounting, law, consulting | Document precision, analysis, decisions |
| Researcher-writer | Blogs, papers, briefs | Sources, synthesis, long-form output |

Designed for this class, not for one person's habits. **Precision verticals** —
financial reconciliation, legal citation — are roadmap, not v1. They need their
own verification model.

## 3. The three pillars

Pillars are the chapters. The loop in § 4 is the mechanism inside them.

### Pillar 1 — The library

Capture anything in one action. Sources are immutable. Notes are what the person
writes; claims are assertions extracted from a source with citation and
confidence; cards are recall units. **Links** connect any two objects and carry
the reason, which is the mechanism that solves "I wrote it down and never went
back." Retrieval combines structured filters, full text, and semantic search.

The library is the asset. Everything else is a way of using it.

### Pillar 2 — The work

Tasks are commitments. Sessions are bounded focus tied to one task. **Stones**
are awarded on completion as memories of finished work, rendered as gemstones,
never revocable. Areas are declared by the person.

Progress is reported as two separate signals, never one composite: **effort**
(volume, focus time, recall activity) and **knowledge confidence** (correct
recall, accepted claims, answers given without looking). A topic with twenty
notes and failed recall is high effort, low confidence — the most useful thing
the system can say.

### Pillar 3 — The agents

A **Supervisor** plans and delegates, holds no direct tools, and cannot widen its
own authority. Sub-agents are invoked as tools with typed inputs and outputs.
**Delegation narrows; it never widens**, enforced in code and tested as an
invariant. Runs are durable with an immutable policy snapshot. External writes
become proposals requiring policy and approval.

## 4. The loop

| Step | What happens | Pillar |
|---|---|---|
| Capture | Something enters in one action with an immutable payload | Library |
| Clarify | The system proposes a destination with a reason; the person accepts, edits, or rejects | Library |
| Commit | A clarified thing becomes an obligation | Work |
| Focus | Bounded work on one task, recording segments and outcome | Work |
| Review | Approve external actions; review completed work | Work, Agents |
| Learn | Finished work becomes retained knowledge | Library |

### Capture and queueing

```
capture arrives
   → source row: kind, origin, raw payload (immutable), text | url | blob
   → state: unprocessed

classifier claims it
   → state: classifying
   → proposal: {kind, reason, evidence, confidence}

person accepts
   → canonical record created
   → lineage recorded: converted_type, converted_id, converted_at
   → state: converted
   → audit + outbox written in the same transaction

otherwise: discarded (payload retained) or failed (reason recorded, retryable)
```

Contract: capture never blocks on enrichment; classification produces a
reviewable proposal and never mutates silently; conversion is transactional with
lineage; duplicates detected on origin identity and URL; failure visible and
retryable.

## 5. Vocabulary

Every term is defined once. A second definition is a defect.

| Term | Meaning |
|---|---|
| Workspace | Tenancy boundary. Every owned row carries `workspace_id`. |
| User | Authenticated person. May belong to several workspaces. |
| Membership | User ↔ workspace link, carrying owner, editor, or viewer. |
| Source | Immutable captured artifact plus extracted text and provenance. |
| Note | Prose written by a person. |
| Claim | Assertion from a source, with citation and confidence. |
| Card | Spaced-repetition unit derived from a note or claim. |
| Link | Typed, reasoned connection between two objects. |
| Task | Actionable commitment with owner, due semantics, state, rationale. |
| Session | Bounded focus period on one task, with segments and outcome. |
| Stone | Reward record for completed work. Three intensity tiers. Never revoked. |
| Area | A topic the person declares, used for effort and confidence. |
| Run | One agent execution. Durable, append-only. |
| Proposal | A suggested mutation with reason and evidence, awaiting acceptance. |
| Pursuit | A task group driven toward an external outcome. |

Retired: *Opportunity* as a top-level concept, *Document* as distinct from
Source, *Lead* as a separate lifecycle.

## 6. Tenancy and access

A user belongs to one or more workspaces. Every record is scoped by
`workspace_id`. Roles are owner, editor, viewer, checked server-side. Invites by
email.

Not in v1, though the schema is ready: per-resource sharing, org hierarchies,
custom roles, cross-workspace visibility, public tenant API.

## 7. Principles

- **The library is the asset.** Every feature enriches it or helps use it.
- **Objects before pages.** Canonical records; screens are views.
- **One record, many views.** A second task store is a bug.
- **Capture never blocks.** Entry speed outranks enrichment completeness.
- **Evidence before confidence.** A number never hides what produced it.
- **Agents propose; policy disposes.**
- **Delegation narrows authority.**
- **No invisible work.** Progress, cost, questions, cancellation, artifacts.
- **Reversible by default.** Unknown outcomes reconcile before retry.
- **Reward completion, never punish loss.** Stones cannot be taken away.
- **Accessible by default.** WCAG 2.2 AA, full keyboard, reduced motion.

## 8. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| P-01 | Any input captured in one action | Each capture path creates a source in `unprocessed` with an immutable payload |
| P-02 | Asynchronous enrichment | Capture returns before classification; queue survives restart |
| P-03 | Reviewable classification | Every proposal names kind, reason, evidence; accept, edit, or reject |
| P-04 | Transactional conversion | Record creation and source closure commit together with lineage and audit |
| P-05 | Visible failure | Failed enrichment is visible, retryable, and carries a reason |
| P-06 | Connected library | Any two objects link with a reason; links are searchable and traversable |
| P-07 | Grounded claims | Every claim cites a source and span; uncited claims are marked unsupported |
| P-08 | Honest progress | Effort and confidence reported separately; neither derived from the other |
| P-09 | Durable sessions | Timer survives navigation and refresh; completion is idempotent |
| P-10 | Stones are memories | A stone records task, duration, area, outcome; never revoked |
| P-11 | Narrowing delegation | A sub-agent's authority is verified as a subset of its delegator's |
| P-12 | Durable runs | Terminal states immutable, events append-only, budget reserved first |
| P-13 | Controlled external action | External writes pass through proposals; replay never repeats an effect |
| P-14 | Tenancy isolation | No query or mutation crosses a workspace boundary |
| P-15 | Attribution | Consequential changes record actor and material versions |
| P-16 | Portability | A person can export their library reviewably, excluding secrets by default |

## 9. Success measures

**Activation.** Capture five items, approve one proposal, complete one session,
earn one stone.

**Operational.** Capture-to-clarification time, queue depth and age, proposal
acceptance rate, session completion, recall accuracy by area, run success and
retry rate, search success.

**Guardrails.** Zero cross-workspace leaks. Zero duplicate external effects.
Zero writes without policy or approval. Zero spend above budget. Zero unresolved
external outcomes older than 24 hours.

## 10. Roadmap

**Phase 0 — the spine.** Identity, membership, `workspace_id` scoping on every
write, request receipts, audit and outbox in one transaction, and a queue that
actually drains. Not user-visible.

**Phases 1 to 4, in parallel after phase 0.**

| Phase | Delivers |
|---|---|
| 1 Capture and library | Sources, notes, claims, links, proposals, search |
| 2 Work and reward | Tasks, sessions, stones, areas, progress reporting |
| 3 Agents | Supervisor, sub-agents, runs, tools, budgets |
| 4 External action | Proposals for external writes, execution, reconciliation |

**After v1.** Precision verticals, mobile, MCP server, public API.

## 11. Open decisions

- The expertise scoring algorithm: weights, signals, and honest confidence.
- The stone intensity algorithm: which inputs map to which tier.
- Which tools each sub-agent may hold.
- The visual identity beyond the stone system.

## 12. Non-goals

- A general team collaboration suite.
- Autonomous external action without policy and approval.
- Fabricated personal claims, name-only merging, credential harvesting, CAPTCHA
  or access-control bypass.
- Reproducing donor experiments as top-level destinations.
