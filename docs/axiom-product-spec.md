# Polymath Product Specification

**Revision:** 2026-10-19, third pass.
**Canonical copy:** Notion, under Command Center / Polymath.
**Shape:** web app, run locally. Desktop and mobile are out of scope.

---

# 1. What Polymath is

Polymath is a workspace for one person doing knowledge work.

Three things compete for a knowledge worker's day. **Things arrive** — mail,
documents, messages, links — and each one is a small decision about what it is
and whether it matters. **Work has to be chosen and done**, against a plan that
is usually wrong about how long it will take. **Knowledge has to accumulate**,
or the same ground gets covered twice and the craft never compounds.

Most tools pick one of the three. A task manager does not keep what you read. A
note app does not know what you owe anyone. An inbox does not know what you are
trying to get better at.

Polymath treats all three as one system over one record set:

| Pillar | The question it answers | Legacy name |
|---|---|---|
| **Command Center** | What arrived, what do I owe, and what is waiting on me? | Command Center |
| **NeuralFlow** | What should I do next, and am I getting better? | NeuralFlow |
| **Alfred** | What do I know, and what can I produce from it? | Alfred |

The boundary between them is a product boundary, never a data boundary. A
document captured in Command Center is the same source Alfred cites. A task
created from a meeting is the same task NeuralFlow schedules. Nothing is copied
to cross a pillar.

# 2. The premise

**You work and get better at what you care about. Agents handle what you do not
want to do.**

That is the whole product. Everything below is machinery for it.

A person's time should go to the part of the craft that requires them: the
judgement, the taste, the synthesis, the decision. The rest — reading to locate
one fact, re-typing a transaction, drafting the fourth variation of the same
email, classifying a file, chasing a follow-up — is real work that does not
require the person. It should be done by something that is good at it, with the
person's authority, and it should be visible.

Polymath has three jobs that follow from that premise:

1. **Protect the person's attention.** Capture fast, decide once, surface what
   actually needs a human.
2. **Make progress visible.** Show effort and improvement honestly, so the
   person can tell whether the time is compounding.
3. **Keep the person's knowledge usable.** Store what they concluded, where it
   came from, and how to get back to it — not just what they read.

# 3. What goes wrong

Four failure classes. Each maps to a pillar; the evidence is in Appendix A.

## 3.1 Coordination failures — Command Center

Commitments made in a message are forgotten because nothing externalised them.
An unanswered email is a decision nobody made. A relationship decays because
maintaining it had no place in the day.

## 3.2 Attention failures — NeuralFlow

Work gets chosen badly and estimated badly. Unfinished tasks intrude on rest.
Progress is judged by feel, and people are poor judges of their own improvement:
the correlation between self-rated ability and measured performance is about
0.29. Without an external record, "I am getting better" is a guess.

## 3.3 Knowledge failures — Alfred

Sources are saved and never reopened; the retrieval that does happen usually goes
through web search rather than the archive. Claims get written without a trace
back to what supports them. Reading does not become recall.

## 3.4 The cost of doing nothing

The person spends the day on coordination and menial work, and the craft they
care about gets the leftover hours.

# 4. Who it is for

Someone who works largely alone, produces written or analysed output, reads more
than they write, keeps notes somewhere they do not revisit, uses LLMs daily, and
carries recurring obligations with deadlines.

**Three concrete personas.**

- **The generalist operator.** Engineering, product, writing. Researches
  constantly, writes long-form, manages applications and correspondence.
- **The professional-services principal.** Accounting, law, consulting. Intake,
  classification, judgement over documents, where being wrong is expensive.
- **The researcher-writer.** Papers, briefs, essays. Many sources, and an
  unsupported claim is a real failure.

**Not for:** teams coordinating on a shared document (v1 has no real-time
collaboration), or anyone wanting an archive to browse.

# 5. The loop

| Step | What happens | Pillar |
|---|---|---|
| **Capture** | Something enters in one action, with no decision about where it goes | Command Center |
| **Clarify** | The system proposes what it is, with a reason | Command Center |
| **Commit** | It becomes an obligation with a reason and a time | NeuralFlow |
| **Do** | Bounded work on one thing, with a visible record | NeuralFlow |
| **Review** | Approve external actions; review finished work | All three |
| **Learn** | Finished work becomes retained, retrievable knowledge | Alfred |

# 6. Pillar 1 — Command Center

**Answers:** what arrived, what do I owe, and what is waiting on me?

## 6.1 Capture

One action from anywhere. Text, URL, file, screenshot, transcript, email. Returns
immediately; classification never blocks. Duplicate detection on origin identity
and URL. Re-capturing something already present surfaces the existing item and
what you already wrote about it.

Not a modal. Not a form. Not a place to choose a project.

*States:* loading, saved, duplicate-found, failed-to-save with retry, offline-queued.

## 6.2 The inbox and classification

The queue of things captured but not yet decided.

Every proposal names a target (note, task, source, person, project, discard), the
**reason**, and the **evidence** it used. Accept, edit, or reject in one action.
The system never files silently. Low confidence is a question, not a guess.

Bulk accept for high-confidence items, so thirty items after a week away take one
action rather than thirty. An empty inbox is valid and not a target to maintain.

*States:* empty, populated, partially classified, failed-and-retryable,
filtered-empty.

## 6.3 Correspondence

Every message that needs to be sent or was received, as a first-class record with
a lifecycle.

`planned → drafted → sent → received`, plus `failed` and `cancelled`. A draft
keeps its source context, so the fourth variation of the same email does not
start from nothing. Sending is an external action and goes through review.

Never send without approval. An uncertain send becomes `unknown` and reconciles
before any retry.

*States:* planned, drafted, awaiting-approval, sending, sent, received, failed,
cancelled, unknown.

## 6.4 Follow-ups

A commitment to get back to someone, with a reason and a date.

`open → done | cancelled | superseded`. A follow-up that a newer message
supersedes says so rather than silently disappearing. Every follow-up shows the
correspondence that created it.

This is the mechanism for the coordination failure in § 3.1: making a plan for an
otherwise-open obligation is what removes its intrusion on attention.

*States:* open, done, cancelled, superseded, overdue.

## 6.5 People and companies

Contacts and organisations with dated observations, not a static address book.
Each observation carries its source and the date it was observed. Employment,
role, and relationship status are observations, not fields that silently decay.

Relationship strength is evidence-based: a reply, a referral, a shared project.
A discovered address is not a relationship. Keeping up with contacts is bounded
by real capacity, so the product surfaces who is going cold rather than pretending
you can maintain everyone.

*States:* no-observations, current, stale, do-not-contact.

## 6.6 The briefing

The home surface. What needs attention now, and why.

Assembles from local data with no LLM call on load. Shows: today's declared
outcomes, up to three suggested next actions, what is due or overdue, what is
waiting on someone else, follow-ups due, reviews pending, and what was finished
recently. Each item states the reason it is shown.

Works with no AI provider configured. A disconnected integration is named, never
rendered as a blank space.

*States:* first-run, populated, degraded with the unavailable source named,
offline.

## 6.7 Spending and providers

What external providers cost, and what is allowed. A budget is captured before
paid work and settled after. No run spends past its captured budget, and no
purchase or top-up happens without policy.

*States:* within-budget, approaching-limit, exhausted, provider-unavailable.

# 7. Pillar 2 — NeuralFlow

**Answers:** what should I do next, and am I getting better?

## 7.1 Tasks and commitments

A task carries an owner, a due semantic (date, time, or none), a state, a
priority, and a **rationale** — why it is on the list. Without the reason, a list
becomes a pile and every item is equally guilt-inducing.

Subtasks, dependencies, recurrence, snooze, archive, bulk edit, undo, and links
to any source, note, or person. **Due dates are optional and honest:** a task
with no date is not overdue.

One task model across list, board, calendar, and focus. A board is a saved view
with ordered columns, never a second task store.

*States:* open, in-progress, waiting, snoozed, done, cancelled. Undo on every
terminal transition.

## 7.2 Planning

Declaring the day's outcomes, and planning work before doing it.

Because estimates are unreliable — large projects overrun by roughly a quarter on
average, with one in six exceeding 200% — the product records the estimate and
the actual separately, and shows the person their own ratio over time. It does
not tell them they were wrong; it shows the pattern.

Planning an obligation is also the mechanism that stops it intruding on rest, so
declaring an outcome is a first-class action, not a formality.

*States:* unplanned, planned, partially-planned, backlog.

## 7.3 Focus sessions

A bounded period of work on exactly one task.

Starting shows the task, its intention, and the last thing you did on it. Timer
state survives navigation, refresh, and closing the tab. Segments and
interruptions are recorded without judgement. Ending asks one sentence about what
was done, which becomes part of the record.

**Leaving mid-session is normal and costs nothing.** Resuming is the feature;
never stopping is not.

*States:* idle, running, paused, interrupted, finished, abandoned (kept as a
record, never a failure).

## 7.4 Stones

The record of a completed piece of work, rendered as a gemstone.

Earned on a finished session with a stated outcome, or on task completion.
Carries the task, the duration, the area, and the person's own sentence.

**Never revoked.** Nothing decays, nothing expires, nothing is lost. A week away
costs nothing.

Intensity comes from observable inputs only: duration, sessions on the same task,
whether the task was declared hard in advance, and whether a previously abandoned
block was finished. Never from a model's opinion of difficulty.

Three tiers: small (one session), large (multi-session task), rare (a milestone
declared in advance). Five stones may be exchanged for a shard — **claimed
explicitly, never auto-converted**.

Not points. Not a streak. Not a leaderboard.

*States:* earned, viewing, collected.

## 7.5 Areas and progress

Areas are declared by the person. No taxonomy is imposed.

Progress is reported as **two separate signals, never one number**:

- **Effort** — what the system can observe: notes written, manual links, sources
  captured, focus time, recall activity.
- **Knowledge confidence** — what it can verify: correct recall in spaced
  repetition, claims accepted, questions answered without looking. Never volume.

They are displayed side by side. A topic with twenty notes and failing recall is
high effort and low confidence, which is the most useful thing the system can
say, and a single composite would hide exactly that.

No number ever claims mastery. Self-assessment is unreliable enough that the
product's value is in replacing the guess with a record, not in replacing it with
another guess.

*States:* no-areas, active, stale, empty.

## 7.6 Review

Two meanings, kept distinct.

**Approving external action** — every outbound change passes through a proposal
with a preview, a risk class, a dedupe key, an expiry, and the expected effect.
Approve, edit, reject, or let it expire.

**Reviewing finished work** — the weekly pass over what was done, what was
learned, and what is next. Not a scorecard.

*States:* nothing-pending, pending, partially-decided, expired.

# 8. Pillar 3 — Alfred

**Answers:** what do I know, and what can I produce from it?

## 8.1 Sources

An immutable captured artifact — web page, PDF, email, screenshot, transcript —
with extracted text and provenance.

The original payload is never mutated. Re-fetching identical content records a new
observation without duplicating the source.

*States:* fetched, extraction-pending, extraction-failed (retryable),
partially-extracted (visibly partial), unsupported.

## 8.2 Notes

Prose the person writes, with checkpoints and version history. Links to any
object. A note can be about a source without being part of it. Drafting
assistance is always visible as assistance.

*States:* draft, edited, unsaved-changes, conflict, deleted-recoverable.

## 8.3 Claims and citations

An assertion attributed to a source, with a span and a confidence.

Clicking a claim opens its source at the cited span. A claim with no source is
visibly marked unsupported. A paraphrase is distinguished from an exact quote.

This is what makes the library usable in professional work: an answer is only as
good as the ability to check it.

*States:* supported, unsupported, contradicted, stale-source.

## 8.4 Links

A typed, reasoned connection between two objects — the retrieval path that does
not depend on remembering to search.

A link carries a relation and a reason. Traversable both ways. **Optional, never
required.** Manual links count for more in effort scoring because they represent
a judgement. The product never tells you your library is incomplete because
things are unlinked.

*States:* proposed, accepted, rejected, dangling (target archived), bidirectional.

## 8.5 Cards and recall

Spaced repetition derived from notes and claims.

Cards are generated and reviewed before entering circulation. Scheduling uses
expanding intervals tied to the intended retention period. Review is retrieval,
not recognition: the answer stays hidden until attempted. A failed card returns
sooner. Every card cites its source.

**The claim is narrow and honest:** this improves recall of facts. It does not
improve judgement, synthesis, or decision quality, and the product does not say
it does.

*States:* proposed, scheduled, due, answered-correctly, answered-wrong,
suspended, retired.

## 8.6 Research and dossiers

A bounded set of sources gathered around a question, with cited answers.

Bounded is the defining property: a chosen set of sources with answers traced to
spans. A dossier that stops being bounded is a note. Every claim retains source,
retrieval time, and uncertainty; interpretation is separated from fact.

*States:* gathering, partial (some sources unreachable), ready, stale.

## 8.7 Search

Structured filters, full text, and semantic similarity over everything.

Results show where they came from and when they were observed. Citation-aware:
searching a claim shows its source. Stale results are marked stale.

*States:* no-results, partial-index, indexing.

# 9. Agents

Work that continues without the person, under declared authority.

| Role | Owns | Cannot |
|---|---|---|
| **Supervisor** | Planning, delegation, stopping | Call tools; widen its own authority |
| **Curator** | Classification, enrichment, dedupe, tagging | Write outside a proposal |
| **Researcher** | Bounded source gathering, claim extraction, citation | Invent a citation; answer without a source |
| **Writer** | Drafting from the library | Assert a fact not in the library |

**The authority rule.** A sub-agent's authority is always a subset of the agent
that invoked it. Delegation narrows; it never widens. Enforced in code, covered
by a test.

Runs are durable: policy snapshot at start, append-only events, immutable
terminal states, budget reserved before spend. Progress, cost, questions, and
artifacts are visible while running. A question pauses the run rather than
guessing.

## 9.1 Skills

Skills are importable procedures — a person teaches the assistant *how* to do a
kind of work without granting it anything new. Import sources: a GitHub
repository, a supported `npx skills add` command, or a local folder. Nothing
imported is executed; a skill's text is data until a run loads it.

- A skill is pinned to the run that invokes it: the procedure, its revision and
  its content hash are frozen at start, so a later edit, disable, or removal
  cannot change what a live run follows.
- A skill never widens authority. Tools still come from the run's frozen
  policy snapshot; skill prose can request an action but cannot authorise one.
- Explicit invocation only: the person picks the skill (Assistant composer or
  the skill's own page). The model is never silently switched onto one.
- Import is inspect-first: the discovered packages, their source, revision and
  warnings are shown before anything is stored, and the server re-verifies the
  content at the shown revision before installing.
- Removal keeps the record: an in-flight run keeps its procedure; the library
  entry disappears from every list.

# 10. Tenancy and access

A person may belong to several workspaces. Every record carries `workspace_id`,
resolved server-side; a client never supplies it. Roles are owner, editor, viewer,
checked on every request. Invites by email.

Not in v1: per-resource sharing, organisation hierarchies, custom roles,
cross-workspace visibility, a public tenant API.

# 11. Vocabulary

| Term | Meaning |
|---|---|
| **Workspace** | The tenancy boundary. Every owned row carries `workspace_id`. |
| **User** | An authenticated person. May belong to several workspaces. |
| **Membership** | User ↔ workspace, carrying owner, editor, or viewer. |
| **Source** | Immutable captured artifact with extracted text and provenance. |
| **Note** | Prose written by a person. |
| **Claim** | Assertion attributed to a source, with citation and confidence. |
| **Card** | Spaced-repetition unit derived from a note or claim. |
| **Link** | Typed, reasoned connection between two objects. |
| **Task** | Commitment with owner, due semantic, state, and rationale. |
| **Session** | Bounded focus on one task. |
| **Stone** | Record of completed work. Never revoked. |
| **Shard** | Five stones, explicitly exchanged. |
| **Area** | Declared topic, used for effort and confidence. |
| **Correspondence** | A message with a lifecycle from planned to sent or received. |
| **Follow-up** | A commitment to return to someone, with a date and a reason. |
| **Dossier** | Bounded source set with cited answers. |
| **Proposal** | Suggested mutation with a reason, awaiting acceptance. |
| **Run** | One agent execution against an objective. |
| **Pursuit** | Task group driven toward an external outcome. |

Retired: *Opportunity* as a top-level concept, *Document* as distinct from
Source, *Lead* as a separate lifecycle, *streak* as a concept.

# 12. Principles

- **Shorten the path to finished work.** A feature that grows the library without
  shortening that path is not built.
- **Capture never blocks.**
- **Objects before pages.** One record, many views.
- **Externalise commitments.** A commitment not written down is a commitment that
  will intrude and then be dropped.
- **Evidence before confidence.** A number never hides what produced it.
- **Measure what is verifiable.** Effort and confidence are separate.
- **Agents propose; policy disposes.**
- **Delegation narrows authority.**
- **No invisible work.**
- **Reversible by default.**
- **Reward completion, never continuity.** Nothing decays, nothing is lost.
- **Accessible by default.**
- **Do not cite what the research does not say.**

# 13. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| P-01 | Any input captured in one action | Every path creates a source with an immutable payload, in `unprocessed` |
| P-02 | Asynchronous enrichment | Capture returns before classification; queue survives restart |
| P-03 | Reviewable classification | Every proposal names a kind, a reason, and evidence |
| P-04 | Transactional conversion | Record creation and source closure commit together with lineage and audit |
| P-05 | Visible failure | Failed enrichment is visible, retryable, with a reason |
| P-06 | Correspondence lifecycle | Every message has a state; no send without approval |
| P-07 | Follow-ups are tracked | A follow-up carries a reason and a date; superseded is explicit |
| P-08 | Grounded claims | Every claim cites a source and span; uncited claims marked unsupported |
| P-09 | Connected library | Any two objects link with a reason; links traverse both ways |
| P-10 | Honest progress | Effort and confidence reported separately, never derived from each other |
| P-11 | Durable sessions | Timer survives navigation and refresh; completion is idempotent |
| P-12 | Stones are memories | Records task, duration, area, outcome; never revoked |
| P-13 | No streaks | No mechanic rewards continuity; a gap costs nothing |
| P-14 | Narrowing delegation | Sub-agent authority verified as a subset of its delegator's |
| P-15 | Durable runs | Terminal states immutable, events append-only, budget reserved first |
| P-16 | Controlled external action | External writes pass through proposals; replay never repeats an effect |
| P-17 | Tenancy isolation | No query or mutation crosses a workspace boundary |
| P-18 | Attribution | Consequential changes record actor and material versions |
| P-19 | Portability | Export is reviewable and excludes secrets by default |
| P-20 | Honest claims | No user-visible statistic the cited research does not support |

# 14. Success measures

**Activation.** Capture five items, accept one proposal, complete one session,
earn one stone, decide one follow-up.

**Operational.** Capture-to-clarification time; queue depth and age; proposal
acceptance rate; follow-ups closed; correspondence awaiting reply; session
completion; recall accuracy by area; run success and retry rate; search success.

**Outcome measures, which matter most.** Finished outputs per month; commitments
closed per week; captured items that reach a decision rather than sitting
unresolved; estimate accuracy over time.

**Guardrails.** Zero cross-workspace leaks. Zero duplicate external effects. Zero
writes without policy or approval. Zero spend above budget. Zero unresolved
external outcomes older than 24 hours.

# 15. Roadmap

Web app, run locally, phase by phase.

**Phase 0 — the spine.** Identity and membership, `workspace_id` scoping on every
write, request receipts, audit and outbox in one transaction, a queue that drains.

| Phase | Delivers |
|---|---|
| 1 Command Center | Capture, inbox, classification, correspondence, follow-ups, briefing |
| 2 NeuralFlow | Tasks, planning, focus sessions, stones, areas and progress |
| 3 Alfred | Sources, notes, claims, links, search, cards |
| 4 Agents and external action | Supervisor, sub-agents, runs, proposals, reconciliation |

Phases 1 to 4 proceed in parallel after phase 0.

# 16. Open decisions

- The expertise scoring algorithm: weights and signals, with confidence from
  verified recall only.
- The stone intensity algorithm.
- Whether shards remain, given they add a collection layer with no evidenced
  benefit.
- Which tools each sub-agent may hold.
- The visual identity beyond the stone system.

# 17. Non-goals

- Desktop and mobile clients. Web app only.
- A team collaboration suite; no real-time co-editing.
- An archive to browse. Collection size is not a success measure.
- Autonomous external action without policy and approval.
- Productivity claims the research does not support.
- Streaks, leaderboards, or anything that punishes a break.
- Fabricated personal claims, name-only merging, credential harvesting, CAPTCHA
  or access-control bypass.

---

# Appendix A — Evidence

The claims in § 3 and the design choices they forced. Numbers marked **modelled**
or **vendor** are not measured findings.

## Coordination

| Finding | Source | Used for |
|---|---|---|
| Email occupies ~28% of an interaction worker's week; ~20% goes to finding internal information. **Modelled estimate**, often misquoted as measured. | [McKinsey 2012](https://www.mckinsey.com/industries/technology-media-and-telecommunications/our-insights/the-social-economy) | Correspondence as a first-class record |
| Top-quartile email users spend 8.8 h/week; 57% of M365 time is communicating. **Vendor telemetry.** | [Microsoft WTI 2023](https://www.microsoft.com/en-us/worklab/work-trend-index/will-ai-fix-work) | Why drafting reuse matters |
| Meetings per user up ~3× since 2020; inefficient meetings are the #1 productivity disruptor; 55% say next steps are unclear. **Vendor survey.** | [Microsoft WTI 2023](https://www.microsoft.com/en-us/worklab/work-trend-index/will-ai-fix-work) | Follow-ups as first-class |
| Email is used as a task manager and filing system; overload is a design property. | [Whittaker & Sidner 1996](https://doi.org/10.1145/238386.238530) | Inbox as a decision queue |
| Prospective-memory failures are common in daily life. | [PLoS ONE 2020](https://doi.org/10.1371/journal.pone.0239581) | Externalising commitments |
| Implementation intentions reliably improve follow-through. | [Gollwitzer & Sheeran 2006](https://doi.org/10.1016/s0065-2601(06)38002-1) | Follow-ups carry a reason and a date |
| Making a specific plan for an unfulfilled goal removes its intrusive cognitive effects. | [Masicampo & Baumeister 2011](https://doi.org/10.1037/a0024192) | Planning is the mechanism, not a formality |
| 63.5 notifications/day observed; more notifications correlated with more negative emotion. | [Pielot et al. 2014](https://doi.org/10.1145/2628363.2628364) | Restrained notifications |
| Active social ties are finite; activating ties deactivates others. | [Miritello et al. 2013](https://doi.org/10.1038/srep01950) | Surface who is going cold |
| **Dunbar's 150 is not statistically defensible**; reanalysis yields 69–109 or 16–42. | [Lindenfors et al. 2021](https://doi.org/10.1098/rsbl.2021.0158) | Never quote 150 |
| Reconnecting dormant ties outperforms relying on current ones. | [Levin et al. 2011](https://doi.org/10.1287/orsc.1100.0576) | Resurfacing old contacts |

## Attention

| Finding | Source | Used for |
|---|---|---|
| 57% of working spheres interrupted; ~11 min before a switch; **25 min 26 s mean to resume same-day**. The "23 minutes" figure is a misquote. | [Mark et al. 2005](https://doi.org/10.1145/1054972.1055017) | Resume is the feature |
| Interrupted work finished *faster* with no quality difference, at more stress and effort. | [Mark et al. 2008](https://doi.org/10.1145/1357054.1357072) | Never promise speed |
| Attention residue: unresolved task A impairs task B. | [Leroy 2009](https://doi.org/10.1016/j.obhdp.2009.04.002) | One task, clear intention |
| People underestimate their own completion times; the bias shrinks when instructed to use past experience. | [Buehler et al. 1994](https://doi.org/10.1037/0022-3514.67.3.366) | Record estimate vs actual |
| Underestimation is **not** consistent across studies; some popular claims are artefacts. | [Halkjelsvik & Jørgensen 2012](https://doi.org/10.1037/a0025996) | Show the person their own ratio, not a norm |
| 1,471 IT projects averaged 27% overrun; one in six exceeded 200%. | [Flyvbjerg & Budzier 2011](https://doi.org/10.2139/ssrn.2229735) | Same |
| Self-rated ability correlates with measured performance at only r ≈ .29. | [Zell & Krizan 2014](https://doi.org/10.1177/1745691613518075) | Progress must be recorded, not felt |
| The classic Dunning-Kruger pattern is partly a statistical artefact; miscalibration survives, the strong version does not. | [Nuhfer et al. 2020](https://doi.org/10.1016/j.intell.2020.101449) | No mastery claims |
| Specific, difficult goals outperform vague ones, but produce narrow focus, distorted risk-taking, and reduced intrinsic motivation. | [Locke & Latham 2002](https://doi.org/10.1037/0003-066X.57.9.705), [Ordóñez et al. 2009](https://doi.org/10.5465/amp.2009.37007999) | Outcomes are declared, not gamified |
| Zeigarnik does **not** replicate as a memory advantage; the tendency to resume unfinished tasks does. | [Meta-analysis 2025](https://doi.org/10.1057/s41599-025-05000-w) | Resume affordance |
| Unfinished tasks intrude on off-job time. | [2026 meta-analysis](https://doi.org/10.1080/10615806.2026.2616302) | Externalise, then rest |
| Progress in meaningful work is the strongest day-to-day driver of inner work life. | [Amabile & Kramer 2011](https://hbr.org/2011/05/the-power-of-small-wins) | Stones record progress |

## Knowledge

| Finding | Source | Used for |
|---|---|---|
| Median bookmark unvisited for ~100 days; half unvisited in the prior three months. | [Abrams et al., CHI '98](https://doi.org/10.1145/274644.274651) | Capture must produce decisions |
| 95%+ re-found after three to six months, and **two-thirds of successful re-findings used no keeping behaviour**. | [Jones et al. 2004](https://doi.org/10.1002/meet.1450410115) | The library stores conclusions, not bookmarks |
| Abandonment factors include ROI — the system must pay back faster than it costs. | [Jones et al. 2008](https://doi.org/10.1002/meet.2008.14504503115) | No mandatory structure |
| Hierarchical folders outperform search and tags for personal collections. | [Bergman & Whittaker](https://doi.org/10.7551/mitpress/9780262035170.001.0001) | No forced taxonomy; filters over folders |
| Expecting future access reduces recall of the information and increases recall of where it is. | [Sparrow et al. 2011](https://doi.org/10.1126/science.1207745) | Recall must be tested, not offloaded |
| Practice testing and distributed practice are high-utility; rereading and highlighting are low. | [Dunlosky et al. 2013](https://doi.org/10.1177/1529100612453266) | Cards test retrieval |
| Optimal spacing scales with retention interval. | [Cepeda et al. 2006](https://doi.org/10.1037/0033-2909.132.3.354), [2008](https://doi.org/10.1111/j.1467-9280.2008.02209.x) | Expanding intervals |
| Repeated testing beats repeated study after mastery. | [Karpicke & Roediger 2008](https://doi.org/10.1126/science.1152408) | Retrieval, not review |
| E-discovery review consumes a median 73% of cost; the bottleneck is human reading. | [RAND 2012](https://www.rand.org/pubs/monographs/MG1208.html) | Citation and skimming, not autonomous judgement |
| Spreadsheet errors occur in a few percent of cells; developers are overconfident. | [Panko 1998](https://doi.org/10.4018/joeuc.1998040102) | Show what a result was derived from |

## Rewards

| Finding | Source | Used for |
|---|---|---|
| Contingent rewards undermined free-choice intrinsic motivation; positive feedback enhanced it. | [Deci et al. 1999](https://doi.org/10.1037/0033-2909.125.6.627) | Reward completion, not continuity |
| Points and leaderboards affect quantity, not intrinsic need satisfaction. | [Mekler et al. 2017](https://doi.org/10.1016/j.chb.2015.08.048) | No leaderboard |
| When GitHub removed streak counters, long streaks were abandoned and activity fell. | [Moldon et al. 2021](https://doi.org/10.1109/icse43902.2021.00058) | No streaks |
| Streaks work by creating dependency: abandoning the app abandons the behaviour. | [Renfree et al. 2016](https://doi.org/10.1145/2851581.2892495) | No streaks |
| Habit formation took 18–254 days; "21 days" is not generalisable. | [Lally et al. 2010](https://doi.org/10.1002/ejsp.674) | No daily obligation |

## Counter-case

Recorded so the product answers it.

1. Search already handles re-finding (Jones 2004), so capture must earn its place by storing conclusions.
2. Folders beat tags for personal collections (Bergman & Whittaker).
3. Systems die of maintenance cost (Jones 2008).
4. A perfect archive may make you less knowledgeable (Sparrow 2011).
5. Nothing shows better organisation improves synthesis or judgement.

**Answer:** the product is judged on finished work and closed commitments, not on
collection size.

---

# Appendix B — What the audits say the pillars already contain

From the donor audits in `docs/audits/` (694 keep/merge/drop decisions).

**Command Center:** daily briefing, quick capture, tasks and commitments, kanban,
spaces and projects, AI planning and brain dump, card micro-actions, calendar,
focus, stones and shards, document intake and vault, classification and rename,
profile facts, contacts and companies, opportunities and leads, outreach and
email, reviews, browser companion, spending, application tracker.

**NeuralFlow:** planning, boards, calendar, focus with Pomodoro, reward economy
(stones and shards), learning.

**Alfred:** notebook, zettels, dossiers, studio, deep research, dictionary,
canvas, learning, blog studio, wiki links and backlinks, graph.

Decisions worth carrying forward: one canonical task model across list, board,
calendar and focus; one source-to-insight loop with provenance; no persona
proliferation; no donor styling.
