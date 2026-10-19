# Polymath Product Specification

**Revision:** 2026-10-19. Supersedes all earlier revisions.
**Canonical copy:** Notion, under Command Center / Polymath.
**Source of decisions:** the Notion Decision Log, rounds 1 to 4.

This file is the repo-side copy, reviewed in PRs. When it and the Notion page
disagree, say so in the PR rather than silently picking one.

This is the whole product written down in plain English: what it is, who it is
for, why each feature exists, how it behaves, and what it deliberately does not
do. Every claim about human behaviour is sourced. Where the evidence contradicts
the product's premise, the contradiction is recorded rather than hidden.

---

# 1. What Polymath is

Polymath is a workspace for people whose work is thinking.

A person's job is not to have information. It is to decide something and then do
it. Reading, capturing, and organising are all in service of that, and a tool
that only helps you accumulate has made the work larger, not smaller.

Polymath does three things:

1. **It takes in what arrives**, quickly and without ceremony, and works out what
   it is.
2. **It shortens the distance from something captured to something decided and
   done** — by keeping the source, the note, the claim, and the task next to each
   other.
3. **It lets supervised agents do the parts that do not need a person**, and
   shows its work.

Polymath is not an archive. The archive exists to serve the decision.

# 2. What actually goes wrong

This section is the evidence base for every design choice below. Each item names
what the research found, and what Polymath does differently because of it.

## 2.1 People save far more than they retrieve

**Finding.** Abrams, Baecker and Chignell surveyed 322 web users and analysed 50
bookmark files. The median bookmark had not been visited in about 100 days.
Roughly half of all bookmarks had been visited in the previous three months;
67% within six months; 96% within a year ([CHI '98](https://doi.org/10.1145/274644.274651)).

**Anecdote.** Someone reads a useful article during a project, saves it "for
later," and never opens it again. Six months later they search the web and find
the same article. The saving cost two seconds and bought nothing.

**What does not follow.** It is tempting to conclude people need a better archive.
The stronger evidence says the opposite. See 2.2.

## 2.2 Re-finding mostly does not use the archive

**Finding.** The Keeping Found Things Found project found participants re-found
95% or more of pages after three to six months — and **two-thirds of successful
re-findings used no explicit keeping behaviour at all**. Search engines and URL
autocomplete did the work ([Jones et al., 2004](https://doi.org/10.1002/meet.1450410115)).

**What this means.** The reason elaborate capture does not pay off is not that the
capture is bad. It is that the archive was never the mechanism for re-finding.

**Therefore.** Polymath does not compete with a web search engine on recall. It
stores what a search engine cannot reconstruct: what *you* concluded, what it
connected to, and what you decided to do about it. A captured source is the
evidence behind a note or a claim, not a bookmark.

## 2.3 Systems die of maintenance cost

**Finding.** Jones, Bruce, Klasnja and Jones ran a six-month interview study of
project information management and identified five factors that lead to
abandonment: visibility, integration, co-adoption, scalability, and **return on
investment** — the system must pay back faster than it costs to maintain
([2008](https://doi.org/10.1002/meet.2008.14504503115)).

**Anecdote.** A person builds a careful tagging taxonomy over a weekend. Three
weeks later a single misfiled note means the taxonomy is inconsistent, the
inconsistency is expensive to fix, and the whole system loses credibility. They
stop tagging. The archive becomes a pile.

**Therefore.** Capture requires zero decisions. Classification is proposed by the
system with a reason, and the person may accept it in one action. No mandatory
taxonomy, no required folder, no naming convention. **Linking is optional and
rewarded, never required.** A library with ten links is not a failure.

## 2.4 Interruption costs stress, not only time

**Finding.** Mark, Gonzalez and Harris observed 24 information workers and found
an average of 11 minutes 4 seconds in a working sphere before switching. 57% of
working spheres were interrupted; 77% of interruptions were resumed the same day,
after an average of 2.3 intervening activities
([CHI '05](https://doi.org/10.1145/1054972.1055017)).

**Finding.** A 2008 follow-up study (N=48) found interrupted participants finished
**faster** and with **no quality difference**, but reported significantly more
stress, frustration, time pressure, and effort
([Mark, Gudith & Klocke](https://ics.uci.edu/~gmark/chi08-mark.pdf)).

**A misquotation to refuse.** The widely repeated "23 minutes 15 seconds to regain
focus" is **not in Mark's papers**. It traces to a 2006 Gallup interview where she
described same-day return to the *original task*, not time to regain depth. The
2008 paper's abstract says the opposite of how the number is used
([forensic account](https://geoffmazeroff.com/2026/03/23/the-context-switching-statistic-that-got-lost-in-translation/)).
Polymath must not use this number.

**Finding.** Leroy (2009) showed "attention residue": unfinished tasks keep
consuming attention after a switch
([OBHDP](https://doi.org/10.1016/j.obhdp.2009.04.002)).

**Therefore.** The focus feature is framed honestly. Polymath does not promise to
eliminate switching or to make you faster. It promises to **make returning cheap**:
one task, its intention, and the last thing you did are restored in one action, so
the residue has somewhere to settle. The benefit claimed is lower stress and fewer
lost threads, not throughput.

## 2.5 Spaced repetition works, but narrowly

**Finding.** Dunlosky et al. reviewed ten study techniques. Only **practice
testing** and **distributed practice** received a "high utility" rating.
Highlighting, rereading, and summarisation were rated **low utility**
([Psychological Science in the Public Interest](https://doi.org/10.1177/1529100612453266)).

**Finding.** Cepeda et al.'s meta-analysis covered 839 assessments across 317
experiments: the optimal spacing gap scales with how long you need to remember
([Psych Bulletin](https://doi.org/10.1037/0033-2909.132.3.354)). A later study
found the optimal gap is 20–40% of a one-week delay but only 5–10% of a one-year
delay ([Psych Science](https://doi.org/10.1111/j.1467-9280.2008.02209.x)).

**Finding.** Karpicke and Roediger showed that repeated *testing* after apparent
mastery produced large delayed-recall gains, while repeated *study* produced none
([Science](https://doi.org/10.1126/science.1152408)).

**Therefore.** Cards are generated from notes and claims, scheduled by expanding
intervals, and tested by retrieval rather than review. Copy at 30% of a one-week
delay, 10% of a one-year delay. **The product claims improved recall of facts. It
does not claim improved judgement, synthesis, or decision quality**, because the
evidence does not support that claim.

## 2.6 Rewards help quantity and can harm motivation

**Finding.** Deci, Koestner and Ryan's meta-analysis of 128 studies found that
engagement-, completion-, and performance-contingent rewards **undermined**
free-choice intrinsic motivation (d = −0.40, −0.36, −0.28). Positive feedback
*enhanced* it (d = 0.33)
([Psych Bulletin](https://doi.org/10.1037/0033-2909.125.6.627)).

**Finding.** Mekler et al. found points, levels, and leaderboards acted as
extrinsic incentives, effective for the **quantity** of performance but not for
satisfying intrinsic needs
([Computers in Human Behavior](https://doi.org/10.1016/j.chb.2015.08.048)).

**Finding.** Moldon, Strohmaier and Wachs studied GitHub's silent removal of
public streak counters: long streaks were abandoned, weekend activity fell, and
some developers quit in-progress multi-day quests outright
([ICSE](https://doi.org/10.1109/icse43902.2021.00058)). This is the cleanest
natural experiment on streaks.

**Finding.** Renfree et al. found streaks and reminders work by creating
**dependency**: when users abandon the app they also disengage from the behaviour
the app was scaffolding ([CHI EA](https://doi.org/10.1145/2851581.2892495)).

**Therefore.** Polymath rewards **completion**, never continuity. There is no
streak in the product. Nothing decays, nothing is lost, and a week away costs
nothing. Stones accumulate and are never revoked. Shards are *claimed*, never
auto-converted, so a reward is never taken by surprise.

**Correction to the current code.** `src/domains/gamification` defines a
`streak_day` reward kind. It contradicts P10 and the evidence above. It should be
removed, not used.

## 2.7 Document-heavy work is bottlenecked on human reading

**Finding.** RAND's study of 57 large e-discovery productions found a median total
spend of $1.8M. **Review consumed a median 73% of cost**, at roughly $18,000 per
gigabyte reviewed. Automated deduplication and filtering reduced volume by only
34% ([RAND, *Where the Money Goes*](https://www.rand.org/pubs/monographs/MG1208.html)).
The bottleneck is people reading, not storage.

**Finding.** Panko's work on spreadsheets found errors in a few percent of all
cells, meaning large models almost certainly contain at least one wrong bottom
line, and developers are systematically overconfident about their own sheets
([1998](https://doi.org/10.4018/joeuc.1998040102)).

**Therefore.** The professional-services persona is real and the pain is
documented — but the value Polymath offers is **skimming and citation**, not
autonomous judgement. Every extracted claim carries a citation to a span so a
professional can check it. The product never presents a reconciliation result as
final without showing what it was derived from.

**A number not to use.** McKinsey's finding that 28% of the workweek goes to email
and about 20% to searching for internal information is real. The popular
restatement "1.8 hours a day searching" is a derived figure that is frequently
misattributed. Do not cite it as measured.

## 2.8 The honest counter-case

These are the strongest arguments that a product like Polymath should not exist.
They are recorded so the product can answer them rather than ignore them.

1. **Re-finding does not need an archive.** (2.2) If search already works, capture
   must justify itself by storing conclusions, not sources.
2. **Folders beat the theory.** Bergman and Whittaker's synthesis finds
   hierarchical folders outperform their critics' claims because they encode
   *where* as well as *what*; search and tags underperform on personal collections
   ([MIT Press](https://doi.org/10.7551/mitpress/9780262035170.001.0001)).
3. **Systems die of maintenance cost.** (2.3) Any required structure loses.
4. **A perfect archive may make you less knowledgeable.** Sparrow, Liu and Wegner
   found that expecting future access reduces recall of the information itself and
   increases recall of *where* to find it
   ([Science 2011](https://doi.org/10.1126/science.1207745)).
5. **Learning evidence does not transfer.** Everything in 2.5 concerns factual
   recall. Nothing shows that better organisation improves synthesis or judgement.

**Polymath's answer.** The product is judged on **decisions and finished work**, not
on collection size. If a feature increases the archive without shortening the path
to a decision, it is not built. That is the test this document applies to itself.

---

# 3. Who it is for

## 3.1 The ideal user

Someone who works largely alone, produces written or analysed output, reads more
than they write, keeps notes somewhere they do not revisit, uses LLMs daily, and
carries recurring obligations with deadlines.

## 3.2 Personas

### Persona A — The generalist operator

A software engineer who researches constantly, writes technical long-form, prepares
for interviews, and manages job applications. Their week is research, then writing,
then a stack of small obligations.

*User story.* "I read four articles while fixing one bug. Two weeks later I write a
post about that bug and I cannot remember which article said what."
→ Polymath keeps the source next to the note, and the claim carries the citation.

*User story.* "I send eleven emails a day and half are variations of the same
three messages."
→ Polymath drafts from prior context, and the person approves before anything is
sent.

### Persona B — The professional-services principal

An accountant or lawyer whose work is intake, classification, and judgement over
documents, with consequences for being wrong.

*User story.* "I retype transactions from a bank statement into a ledger, then
classify each one. I cannot afford to misread a figure."
→ Polymath proposes a classification against the source with the figure visible,
and never commits without showing what it read.

*User story.* "A client sends a 60-page contract and asks whether a clause is
standard."
→ Polymath cites the span it is answering from, and states when it does not know.

### Persona C — The researcher-writer

Someone producing papers, briefs, or essays from many sources, where an unsupported
claim is a real failure.

*User story.* "I have 40 sources and I need to know which ones support this
argument, and which contradict it."
→ Every claim in Polymath carries its source and a confidence, and uncited claims
are visibly marked.

## 3.3 Who it is not for

- Teams coordinating on shared documents. v1 has no real-time collaboration.
- People who want an archive to browse. The product optimises for finishing.
- Anyone needing regulatory-grade assurance from automation alone. Polymath
  proposes; a human disposes.

---

# 4. The three pillars

Pillars are the chapters of the product. The loop in § 5 is the mechanism inside
them.

## 4.1 Pillar 1 — The library

**What it is.** Everything the person has decided is worth keeping, stored so it
can be used.

**Why it exists.** Because a source on its own is a bookmark, and a conclusion
attached to its source is knowledge. The library's purpose is to keep conclusions
and their evidence together.

**What it contains.**

| Unit | What it is | Who writes it |
|---|---|---|
| **Source** | An immutable captured artifact: web page, PDF, email, screenshot, transcript, with extracted text and provenance | The system |
| **Note** | Prose written by the person | The person, sometimes with a draft |
| **Claim** | An assertion attributed to a source, with a citation and a confidence | A person or an agent, always reviewable |
| **Card** | A recall unit derived from a note or claim | The system, reviewed by the person |
| **Link** | A typed, reasoned connection between any two objects | A person or an agent |

**What it does not do.** It does not mandate structure. There is no folder tree to
maintain, no required tag, and no "inbox zero" obligation. An uncategorised library
is valid.

**The honest limit.** As § 2.2 shows, retrieval mostly happens through search, not
through the archive. The library earns its place by storing what search cannot
reconstruct: your conclusions, your links, your citations.

## 4.2 Pillar 2 — The work

**What it is.** Attention, commitment, progress, and reward.

**Why it exists.** Because the thing that stops work is not a lack of information.
It is switching, residue, and the absence of a clear next action.

**What it contains.**

| Unit | What it is |
|---|---|
| **Task** | A commitment with an owner, a due semantic, a state, and a stated reason |
| **Session** | A bounded period of focused work on one task, with segments and an outcome |
| **Stone** | The record of a completed piece of work, rendered as a gemstone |
| **Area** | A topic the person declares, used to attribute effort and measure confidence |

**Progress is two numbers, never one.**

- **Effort** — what the system observes: notes written, links created manually,
  sources captured, focus time, recall activity.
- **Knowledge confidence** — what the system can verify: correct recall over spaced
  repetition, claims accepted, questions answered without looking.

They are displayed separately. A topic with twenty notes and failing recall is high
effort and low confidence, which is the most useful thing the system can tell
someone. A single composite would hide exactly that.

**What it does not do.** It does not promise to eliminate interruption (§ 2.4). It
makes returning cheap. It does not use streaks (§ 2.6).

## 4.3 Pillar 3 — The agents

**What it is.** Work that continues without the person present, under declared
authority.

**Why it exists.** Because a large share of the work is reading, extracting,
classifying, and drafting — and none of it needs to be done by hand.

**The org.**

| Role | Owns | Cannot do |
|---|---|---|
| **Supervisor** | Planning, delegation, stopping | Call tools directly; widen its own authority |
| **Curator** | Classification, enrichment, dedupe, tagging | Write anything outside a proposal |
| **Researcher** | Bounded source gathering, claim extraction, citation | Invent a citation; answer without a source |
| **Writer** | Drafting from the library | Assert a fact not present in the library |

**The authority rule.** A sub-agent's authority is always a **subset** of the agent
that invoked it. Delegation narrows; it never widens. This is enforced in code and
covered by a test.

**What it does not do.** It never performs an external action — sending, publishing,
deploying, deleting — without a proposal and an approval. It never presents an
inference as a fact.

---

# 5. The loop

Every feature is justified by the step it serves.

| Step | What happens | Pillar |
|---|---|---|
| **Capture** | Something enters in one action. No decision about where it goes. | Library |
| **Clarify** | The system proposes what it is, with a reason. The person accepts, edits, or rejects. | Library |
| **Commit** | It becomes an obligation: a task, an area, a session. | Work |
| **Focus** | Bounded work on one task, with an outcome. | Work |
| **Review** | Approve external actions; review finished work. | Work, Agents |
| **Learn** | Finished work becomes retained knowledge. | Library |

---

# 6. Features in detail

Each feature states what it is, why it exists, how it behaves, the states it must
ship, and what it is not.

## 6.1 Capture

**What it is.** The single entry point for anything entering the system.

**Why it exists.** Every other feature depends on something having been captured,
and capture is the moment a person is least willing to make decisions. Requiring a
destination at capture time is the fastest way to lose the item.

**How it behaves.**

- One action from anywhere. `⌘K`, a keystroke, a share sheet, a forwarded email, a
  dropped file.
- Accepts text, URL, file, screenshot, transcript, email.
- Returns immediately. Classification never blocks.
- Duplicate detection on origin identity and URL. Re-capturing something already
  present surfaces the existing item rather than creating a second.

**States it must ship.** Loading, saved, duplicate-found, failed-to-save (with
retry), offline-queued.

**What it is not.** Not a modal. Not a form. Not a place to choose a project.

**User stories.**

- As a person reading on my phone, I capture a paragraph in one gesture and decide
  later.
- As a person at my desk, I paste a URL and it lands in the inbox without asking me
  anything.
- As a person who already captured this article last month, I am told it exists and
  shown what I already wrote about it.

## 6.2 Classification and proposals

**What it is.** The system proposes what a captured item is.

**Why it exists.** Because deciding is work, and a good proposal turns a decision
into an acknowledgement.

**How it behaves.**

- Every proposal names a target kind (note, task, source, reference, person,
  project, discard), a **reason**, and the **evidence** it used.
- The person accepts, edits, or rejects. Acceptance is one action.
- A proposal never mutates anything on its own.
- Confidence is shown. Low confidence is expressed as a question, not a silent guess.

**States.** Proposed, accepted, edited-then-accepted, rejected, failed.

**What it is not.** Not an auto-filing system. Not a black box.

**User stories.**

- As a person, I am told "this looks like a note about distributed systems because
  it is prose you wrote and it mentions three concepts you already have notes on"
  and I can accept with one key.
- As a person, when the system is unsure it asks rather than guessing.
- As a person, I can tell it to stop proposing a particular kind, and it remembers.

## 6.3 The inbox

**What it is.** The queue of captured things that have not yet been clarified.

**Why it exists.** So that capture can stay decision-free while still having a
place where decisions happen.

**How it behaves.**

- Ordered by arrival, newest first.
- Shows what the system thinks each item is, beside the item.
- One action per item: accept, edit, discard, or open.
- **Bulk accept is available** for items the system is confident about.
- An empty inbox is a valid state and is not a target to maintain.

**States.** Empty (an invitation to capture), populated, partially classified,
failed items visible and retryable, filtered-empty.

**What it is not.** Not a to-do list. Not a reading queue that must be emptied.

**User stories.**

- As a person with 30 items after a week away, I can accept the 22 the system is
  confident about in one action and deal with the 8 it flagged.
- As a person, I can see why an item failed and retry it.
- As a person, I never see an empty inbox over a failed load.

## 6.4 Notes

**What it is.** Prose the person writes.

**Why it exists.** Because the conclusions are the valuable thing, not the sources.

**How it behaves.**

- Rich text with checkpoints and version history.
- Links to any object: a source, another note, a claim, a task, a person.
- A note can be about a source without being part of it.
- Drafting assistance is available and always visible as assistance.
- Autosave with recovery. Unsaved-work protection.

**States.** Draft, edited, with-unsaved-changes, conflict (someone else edited),
deleted-recoverable.

**What it is not.** Not a second wiki. Not a place where an agent writes without
being attributed.

**User stories.**

- As a person, I can see the article I am writing about beside my note.
- As a person, when I return after a crash, my draft is there.
- As a person, I can see which sentences came from a draft and which I wrote.

## 6.5 Sources and citations

**What it is.** The immutable record of what was captured, and the link from a
claim back to it.

**Why it exists.** Because a claim without a source is an assertion, and in
professional work an unsupported assertion is a failure.

**How it behaves.**

- The original payload is never mutated. Extracted text is stored alongside it.
- A claim carries a source id, a span, and a confidence.
- Clicking a claim opens the source at the cited span.
- A claim with no source is visibly marked unsupported.
- Re-fetching identical content records a new observation without duplicating the
  source.

**States.** Fetched, extraction-pending, extraction-failed (retryable),
partially-extracted (visible as partial), unsupported-claim.

**What it is not.** Not a web clipper that stores a link and calls it a source.

**User stories.**

- As a person checking my own writing, I click a claim and see the exact paragraph
  it came from.
- As a person, when extraction fails I see why, and I can still read the raw text.
- As a person, I am told when a quote is a paraphrase rather than an exact span.

## 6.6 Links

**What it is.** A typed, reasoned connection between two objects.

**Why it exists.** This is the answer to "I wrote it down and never went back." A
link is a retrieval path that does not depend on remembering to search.

**How it behaves.**

- A link carries a relation type and a reason.
- Proposals suggest links when two objects share a concept, and the person accepts.
- Links are traversable in both directions.
- **Optional, never required.** No mandatory linking, no orphan penalty.
- Manual links count for more than proposed ones in effort scoring, because they
  represent a judgement.

**States.** Proposed, accepted, rejected, dangling (target archived), bidirectional.

**What it is not.** Not a graph the user must maintain. Not a reason to block
anything.

**User stories.**

- As a person writing a note, I am shown three existing notes it probably relates
  to, and I accept one.
- As a person, I can see everything that links to this note.
- As a person, I am never told my library is "incomplete" because things are
  unlinked.

## 6.7 Tasks and commitments

**What it is.** A stated commitment with a reason.

**Why it exists.** Because the reason a task is on a list is what makes it possible
to judge whether it still matters.

**How it behaves.**

- Owner, due semantic (date, time, or none), state, priority, and **rationale**.
- Subtasks and dependencies.
- Recurrence.
- Snooze and archive.
- Bulk edit and undo.
- Links to sources, notes, and people.
- Due dates are optional and honest. A task with no date is not overdue.

**States.** Open, in-progress, snoozed, done, cancelled. Undo available for every
terminal transition.

**What it is not.** Not a project management tool for teams. Not a place where an
agent completes a task silently.

**User stories.**

- As a person, I can see why I added this task three weeks ago.
- As a person, completing a task gives me a stone and asks one question: what did
  you actually do?
- As a person, an agent can propose a task but cannot complete one on my behalf
  without telling me.

## 6.8 Focus sessions

**What it is.** A bounded period of work on exactly one task.

**Why it exists.** Because returning to a task is expensive (§ 2.4), and the
cheapest way to make returning cheap is to make what you were doing unambiguous.

**How it behaves.**

- Starting a session names one task and shows the last thing you did on it.
- Timer state survives navigation, refresh, and closing the tab.
- Segments and interruptions are recorded without judgement.
- Ending a session asks for one sentence about what was done.
- The sentence becomes part of the stone.
- **Leaving mid-session is normal and costs nothing.**

**States.** Idle, running, paused, interrupted, completed, abandoned (kept as a
record, never as a failure).

**What it is not.** Not a Pomodoro enforcer. Not a productivity score. Not a
surveillance tool.

**User stories.**

- As a person interrupted by a call, I pause and return without losing the thread.
- As a person starting Monday, I see the last thing I was doing on this task.
- As a person, when I abandon a session nothing is taken away from me.

## 6.9 Stones

**What it is.** The record of a completed piece of work, rendered as a gemstone.

**Why it exists.** Because completion deserves acknowledgement, and because a
record of finished work is more useful than a record of attempted work.

**How it behaves.**

- Earned on session completion with a stated outcome, or task completion.
- Carries: the task, the duration, the area, and the person's own sentence.
- **Never revoked.** Nothing decays, nothing expires, nothing is lost.
- Intensity is computed from observable inputs only: duration, sessions on the
  same task, whether the task was declared hard in advance, whether a previously
  abandoned block was completed. Never from a model's opinion of difficulty.
- Three presentation tiers: small (one session), large (multi-session task),
  rare (a milestone declared in advance).
- Shards: five stones may be exchanged for a shard. **Claimed explicitly, never
  auto-converted**, so nothing is ever taken by surprise.

**States.** Earned, viewing, collected.

**What it is not.** Not points. Not a streak. Not a leaderboard. Not competitive.

**User stories.**

- As a person finishing a hard week, I can see every stone I earned and what I said
  about each one.
- As a person taking two weeks off, I lose nothing.
- As a person, my stone reveal never blocks me from continuing.

## 6.10 Areas and progress

**What it is.** Declared topics, each with effort and confidence reported
separately.

**Why it exists.** Because "am I getting better at this" is a real question, and
answering it with one number is a lie.

**How it behaves.**

- The person declares areas. No taxonomy is imposed.
- **Effort** counts notes, manual links, captures, focus time, and recall activity.
- **Knowledge confidence** counts correct recall, accepted claims, and answers given
  without looking. It never counts volume.
- The two are displayed side by side, never averaged.
- The system suggests where effort is high and confidence is low.

**States.** No areas yet, active, stale (no activity in a period), empty.

**What it is not.** Not a mastery claim. Not a comparison with other people.

**User stories.**

- As a person, I see that I have written a lot about distributed systems but fail
  most recall on it, and that tells me to study rather than read.
- As a person, I can declare a new area in one action.
- As a person, no number ever tells me I am an expert.

## 6.11 Cards and recall

**What it is.** Spaced-repetition units derived from notes and claims.

**Why it exists.** Because testing beats rereading, with strong evidence (§ 2.5).

**How it behaves.**

- Cards are generated from a note or claim and reviewed before entering circulation.
- Scheduling uses expanding intervals tied to the intended retention period.
- Review is retrieval, not recognition. The answer is hidden until attempted.
- A failed card returns sooner. A passed card moves further out.
- Cards cite their source.

**States.** Proposed, scheduled, due, answered-correctly, answered-wrong,
suspended, retired.

**What it is not.** Not a claim about judgement. Not a grading system.

**User stories.**

- As a person, I review twelve cards in four minutes and see which topic is weak.
- As a person, I can retire a card that no longer matters.
- As a person, a card always shows me where it came from.

## 6.12 The briefing

**What it is.** The home surface: what needs attention now.

**Why it exists.** Because starting work should not require deciding what work is.

**How it behaves.**

- Assembles from local data without an LLM call on load.
- Shows: due commitments, the queue, waiting items, reviews needed, running agents,
  and what was finished recently.
- Explains why each item is shown.
- Works without any AI provider configured.

**States.** Empty (first run), populated, degraded (a source is unavailable, named),
offline.

**What it is not.** Not an analytics dashboard.

**User stories.**

- As a person at 9am, I see three things that matter and I know why each is there.
- As a person, when my calendar is disconnected I am told, not shown a blank space.
- As a person, I can start a session directly from the briefing.

## 6.13 Agents and runs

**What it is.** Durable execution with visible progress.

**Why it exists.** Because work that happens without you must still be accountable.

**How it behaves.**

- A run has a policy snapshot at start: profile, model, tools, budget, workspace.
- Events are append-only. Terminal states are immutable. Retries create new runs.
- Progress, cost, questions, and artifacts are visible while running.
- The person can cancel at any point.
- Questions pause the run rather than guessing.
- External actions become proposals.

**States.** Queued, running, waiting-for-input, waiting-for-approval, succeeded,
failed, cancelled.

**What it is not.** Not a chat box with hidden behaviour. Not autonomous.

**User stories.**

- As a person, I can see what an agent is doing and how much it has cost.
- As a person, when it needs a decision it asks and waits.
- As a person, I can stop a run and nothing external has happened without me.

## 6.14 Proposals and review

**What it is.** Every change that would leave the system, and every change an agent
wants to make to the library.

**Why it exists.** Because reversible-by-default is the only safe posture.

**How it behaves.**

- A proposal carries a preview, a risk class, a dedupe key, an expiry, and the
  expected effect.
- Approve, edit, reject, or let it expire.
- Replay never repeats an external effect.
- An uncertain outcome becomes `unknown` and is reconciled before any retry.

**States.** Proposed, approved, rejected, expired, executing, succeeded, failed,
unknown.

**What it is not.** Not a confirmation dialog. Not a rubber stamp.

**User stories.**

- As a person, I see exactly what will be sent before I send it.
- As a person, if a send times out I am told the outcome is unknown, not that it
  failed.
- As a person, a proposal expires rather than silently waiting forever.

## 6.15 Search

**What it is.** Retrieval across everything.

**Why it exists.** Because § 2.2 shows search is how people actually re-find things.

**How it behaves.**

- Combines structured filters, full text, and semantic similarity.
- Results always show where they came from and when they were observed.
- Filters by kind, area, date, and source.
- Citation-aware: searching for a claim shows its source.

**States.** No results, partial index, indexing-in-progress.

**What it is not.** Not a replacement for the web. Not a black-box ranking.

**User stories.**

- As a person, I search "idempotency" and see my notes, the sources I captured, and
  the claims I extracted.
- As a person, I can see when a result is stale.
- As a person, I can find a note by what it cited, not only by its title.

## 6.16 Tenancy and access

**What it is.** Workspaces, members, roles.

**Why it exists.** Because a knowledge library is private, and a shared workspace
must not leak.

**How it behaves.**

- A person may belong to several workspaces.
- Every record carries `workspace_id`. The server resolves it; a client never
  supplies it.
- Roles: owner, editor, viewer. Checked server-side on every request.
- Invites by email.

**States.** Single member, invited-pending, member, removed, role-changed.

**What it is not.** Not an organisation hierarchy. Not per-record sharing in v1.

**User stories.**

- As a person, my personal workspace is invisible to anyone else, always.
- As a person, I can invite someone to a shared workspace without giving them my
  personal one.
- As a person, removing a member ends their access immediately.

---

# 7. Vocabulary

Every term is defined once. A second definition is a defect.

| Term | Meaning |
|---|---|
| **Workspace** | The tenancy boundary. Every owned row carries `workspace_id`. |
| **User** | An authenticated person. May belong to several workspaces. |
| **Membership** | The link between a user and a workspace, carrying a role. |
| **Source** | An immutable captured artifact plus extracted text and provenance. |
| **Note** | Prose written by a person. |
| **Claim** | An assertion attributed to a source, with citation and confidence. |
| **Card** | A spaced-repetition unit derived from a note or claim. |
| **Link** | A typed, reasoned connection between two objects. |
| **Task** | A commitment with owner, due semantic, state, and rationale. |
| **Session** | A bounded period of focused work on one task. |
| **Stone** | The record of a completed piece of work. Never revoked. |
| **Shard** | Five stones, explicitly exchanged. Never automatic. |
| **Area** | A declared topic, used for effort and confidence. |
| **Run** | One execution of an agent against an objective. |
| **Proposal** | A suggested mutation with a reason, awaiting acceptance. |
| **Pursuit** | A task group driven toward an external outcome. |

Retired: *Opportunity* as a top-level concept, *Document* as distinct from Source,
*Lead* as a separate lifecycle, *streak* as a concept.

---

# 8. Principles

- **Shorten the path to a decision.** If a feature grows the archive without
  shortening the path to finished work, it is not built.
- **Capture never blocks.**
- **Objects before pages.**
- **One record, many views.** A second task store is a bug.
- **Evidence before confidence.** A number never hides what produced it.
- **Agents propose; policy disposes.**
- **Delegation narrows authority.**
- **No invisible work.**
- **Reversible by default.**
- **Reward completion, never continuity.** Nothing decays, nothing is lost.
- **Measure what is verifiable.** Effort and confidence are separate.
- **Accessible by default.**
- **Do not cite what the research does not say.**

---

# 9. Requirements

| ID | Requirement | Acceptance |
|---|---|---|
| P-01 | Any input captured in one action | Every capture path creates a source with an immutable payload, in `unprocessed` |
| P-02 | Asynchronous enrichment | Capture returns before classification; queue survives restart |
| P-03 | Reviewable classification | Every proposal names a kind, a reason, and evidence; accept, edit, reject |
| P-04 | Transactional conversion | Record creation and source closure commit together with lineage and audit |
| P-05 | Visible failure | Failed enrichment is visible, retryable, with a reason |
| P-06 | Connected library | Any two objects link with a reason; links traverse both ways |
| P-07 | Grounded claims | Every claim cites a source and span; uncited claims are marked unsupported |
| P-08 | Honest progress | Effort and confidence reported separately; never derived from each other |
| P-09 | Durable sessions | Timer survives navigation and refresh; completion is idempotent |
| P-10 | Stones are memories | A stone records task, duration, area, outcome; never revoked |
| P-11 | No streaks | No mechanic rewards continuity; a gap costs nothing |
| P-12 | Narrowing delegation | A sub-agent's authority is verified as a subset of its delegator's |
| P-13 | Durable runs | Terminal states immutable, events append-only, budget reserved first |
| P-14 | Controlled external action | External writes pass through proposals; replay never repeats an effect |
| P-15 | Tenancy isolation | No query or mutation crosses a workspace boundary |
| P-16 | Attribution | Consequential changes record actor and material versions |
| P-17 | Portability | A person can export their library reviewably, excluding secrets by default |
| P-18 | Honest claims | No user-visible statistic that the cited research does not support |

---

# 10. Success measures

**Activation.** Capture five items, accept one proposal, complete one session, earn
one stone.

**Operational.** Capture-to-clarification time; queue depth and age; proposal
acceptance rate; session completion; time-to-return after an interruption; recall
accuracy by area; run success and retry rate; search success.

**Outcome measures, which matter most.** Finished outputs per month; decisions made
per week; tasks completed with a stated outcome; the ratio of captured items that
reach a decision rather than sitting unresolved.

**Guardrails.** Zero cross-workspace leaks. Zero duplicate external effects. Zero
writes without policy or approval. Zero spend above budget. Zero unresolved
external outcomes older than 24 hours.

---

# 11. Roadmap

**Phase 0 — the spine.** Identity and membership, `workspace_id` scoping on every
write, request receipts, audit and outbox in one transaction, a queue that drains.
Not user-visible.

**Phases 1 to 4, in parallel after phase 0.**

| Phase | Delivers |
|---|---|
| 1 Capture and library | Sources, notes, claims, links, proposals, search |
| 2 Work and reward | Tasks, sessions, stones, areas, progress reporting |
| 3 Agents | Supervisor, sub-agents, runs, tools, budgets |
| 4 External action | Proposals for external writes, execution, reconciliation |

**After v1.** Precision verticals (financial reconciliation, legal citation), mobile,
MCP server, public API.

---

# 12. Open decisions

- The expertise scoring algorithm: weights and signals, with confidence computed
  only from verified recall.
- The stone intensity algorithm.
- Whether shards remain, given they add a collection layer with no evidenced benefit.
- Which tools each sub-agent may hold.
- The visual identity beyond the stone system.

---

# 13. Non-goals

- A general team collaboration suite.
- An archive to browse. Collection size is not a success measure.
- Autonomous external action without policy and approval.
- Claims about productivity that the research does not support.
- Streaks, leaderboards, or anything that punishes a break.
- Fabricated personal claims, name-only merging, credential harvesting, CAPTCHA or
  access-control bypass.
