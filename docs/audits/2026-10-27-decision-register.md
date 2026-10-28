# Decision register — intent vs implementation

**Compiled 2026-10-27** from 120 Linear "Done" tickets, the binding docs
(`agents/*`), and reads of the code at `0aa50a36ccc8b3cc272cff1d7d47a7db7da90ef5`.

**Why this exists.** "Done" in this workspace means *merged and linked to a PR*
(ASH-180, decision 6). It has never meant "live-verified". Planning from the Done
column therefore plans on belief. This register records what was **intended**, what
**shipped**, and what a reader may **rely on now** — separately.

## How to read it

| Verdict | Means |
|---|---|
| **Built** | In the code at the pinned commit; a reader can rely on the mechanism existing |
| **Built, unclaimed** | Exists but is deliberately outside the release claim (ASH-180 "cut from the release claim") |
| **Partial** | Some path exists; a named part does not |
| **Contradicted** | A later decision or the code reverses the ticket |
| **Not in this product** | Ticket belongs to a different product |

---

## 0. The product direction, as the tickets state it

The arc, in the order it was decided:

1. **Consolidate three donor repos** (`command-center`, `alfred`, `neuralflow`) into one app. Question at ASH-103/104, executed from ASH-104 onward.
2. **Five loops, five destinations** (ASH-199, ASH-203): START (Today, Inbox, Reviews, Activity) / DO (Work, Focus, Conversations) / KNOW (Sources, Library, Wiki, Dossiers, Learning) / AGENTS (Assistant, Skills) / OPS (People, Companies, Opportunities, Spending, Connectors).
3. **Flagship journey** (ASH-201): source material → editable cited output → reviewed next actions → return and continue. *Leave and return are the proof.*
4. **Release boundary** (ASH-180, decision 3): one loop — document in → extraction reviewed → task created → focus session → weekly review, plus one approval-gated agent action and one proven budget stop.
5. **Thesis shift, 2026-10-27** (memory: archetype-evals-pivot): the asset is **archetype packs** — workflows, prompts, and evals that prove the agent does a role's job well. First pack: the one-person operator. This supersedes the 14-day GTM plan, not the five-loop product shape.

**The intended product**, in one sentence the tickets actually support: *a personal operating environment where captured information becomes durable, cited knowledge and reviewed, actionable work, with agents operating under explicit permissions, budgets, and approval.*

---

## 1. Contradictions and inflation — fix these first

### C-1. ASH-231 … ASH-266 are a different product

15+ tickets marked Done (`0.1 — Auth hardening`, `1.1 — Adopt astronomy-engine`,
`3.2 — Headline quality bar`, `6.1 — Synastry engine`, …) describe an **astrology
application on Supabase**: `birth_profiles`, `daily_readings`,
`compatibility_reports`, `RULESET_VERSION`, ephemeris validation.

**None of it is in this repository.** Checked: no `supabase/migrations`,
no `daily_readings`, no `astronomy-engine` dependency.

**Verdict: Not in this product.** They are not wrong, they are elsewhere — a second
project in the same `ASH` team. They make "120 Done tickets" read as 120 units of
Polymath progress when ~15 of them are a different product.

**Decision needed:** move them to a separate Linear team or project. Until then,
any query over `ASH` Done is wrong by construction.

### C-2. Two live write paths for the same concept

`tool_calls` and `tool_invocations` both record agent tool use, both scoped by
`workspace_id`, both carrying `run_id`, `tool_name`, `account_alias`, redacted
arguments, and a result.

- `tool_calls` is written by `agents/event-bridge.ts` and `agents/gateway.ts`.
- `tool_invocations` is written by `agents/runtime-persistence.ts`, and additionally
  carries `execution_id`, `arguments_hash`, `effect_class`, and a `state` machine.

**Verdict: Partial — ambiguous authority.** These may be a legitimate
logical-call / physical-invocation split, but nothing in the code states the
cardinality, and the field overlap means a reader cannot tell which is authoritative
for "what did the agent actually do".

**Decision needed:** state the cardinality explicitly (run → execution → logical
call → invocation attempt, or collapse). If they are the same lifecycle, designate
one writer. Do not leave both live.

### C-3. Party identity has two homes

`identity.people` (`display_name`, `honorific`, `title`) and `crm.contacts`
(`full_name`, `primary_email`, `phone`, `relationship_status`, `last_interaction_at`)
are both workspace-scoped and both describe a person.

`contact_companies` exists alongside `party_employment`.

**Verdict: Partial — deliberate but undocumented.** The split *can* be correct
(person = identity, contact = relationship record). It is a real risk only if both
independently resolve the same human. The table that would make it safe — a link
from `contacts` to `people` — is what to check for next; `contact_companies` and
`party_employment` coexisting is the tell that the split was not finished.

**Decision needed:** either declare `contacts` a relationship profile that always
references a `person`, or merge. Do not let them diverge silently.

### C-4. `knowledge` owns financial interpretation

`knowledge` holds 48 tables, including `statement_imports`,
`statement_transactions`, and `transaction_category_rules` — accepted financial
records, not extracted documents.

**Verdict: Built, boundary wrong.** Preserving a statement and its extraction is
knowledge work. Maintaining *accepted transactions and their categorisation* is
financial state. The same domain owns both, so "did the user accept this
transaction" and "did extraction read this PDF" have one owner.

**Decision needed:** not a table move. Declare that `knowledge` owns the preserved
statement and extraction, while accepted transactions are a financial record with
provenance back to the source. The command boundary matters more than the folder.

---

## 2. Direction ensured by code, worth keeping

These are the bets that survived and are load-bearing. Do not re-litigate them.

| Decision | Ticket | Where it lives | Verdict |
|---|---|---|---|
| Proposals are separate from canonical records | ASH-109/110 | `capture_proposals`, `field_proposals`, `schedule_proposals`, `zettel_proposals` | Built |
| Attempts are separate from intentions | ASH-122 | `action_attempts`, `job_attempts`, `document_extraction_attempts` | Built |
| Evidence is first-class | ASH-110 §6 | `claims`, `claim_evidence`, `sources`, `reviewed_assertions` | Built |
| Approval binds to an exact revision | ASH-122 | `action_reviews.revision_id` NOT NULL FK | Built |
| Delegation narrows authority | ASH-122 | `agent_delegation_grants`, subset test | Built |
| Reserve before spend, settle after | ASH-147 | `spending_reservations`, `spend_settlements` | Built |
| One task model, many views | ASH-109 §3 | `tasks` + boards as saved views | Built |
| Four time concepts stay distinct | ASH-109 §6 | deadline / planned block / event / session | Built |
| Stones never revoked, no streaks | ASH-109 §9 | `reward_ledger`, no decay column | Built |
| Idempotent mutations | ASH-190 | `request_receipts` + `withReceipt`, 55 call sites | Built |
| Outbox with lease fencing | ASH-134/178 | `outbox_events`, `for update skip locked` | Built |
| Typed relation vocabulary | ASH-110 §6 | 14 types in `artifactTypes` with DB check | Built |

---

## 3. Where "Done" overstates

| Ticket | Claim | Reality at the pinned commit |
|---|---|---|
| ASH-189 | Hosted unattended drain | Schedule + GET entry point exist; the drain is **daily**. Not a worker. |
| ASH-191 | Unknown outcomes reconcile within 24h | `resolveUnknownSend` + tests exist; **no process reads the stale set on a schedule** and no alert is wired. |
| ASH-185 | Tasks and calendar | Marked "Unverified until a live calendar read is demonstrated" by ASH-180 itself. Still unverified. |
| ASH-194 / release | 7-step acceptance script | **Never run.** ASH-180 shows all 7 steps "Not run". |
| ASH-232 (astrology) | Data model v2 with RLS tests | Different product (C-1). |
| ASH-266 … 231 | 15 astrology capabilities | Different product (C-1). |

**Net:** the release ledger's own words are still accurate — *"What remains is
evidence from the hosted environment and from a person — no gate is waiting on
unwritten code."* The code is further along than the evidence. That is the gap to
close, not more features.

---

## 4. What to build next

Ranked by what makes a claim falsifiable, which is the current bottleneck.

1. **Separate the astrology tickets** (C-1). Costs minutes; every future progress
   query depends on it.
2. **Run the 7-step acceptance script** (ASH-194). Six of six code gates have proof;
   this is the only remaining gate and it is human-only. It is also the fastest way
   to discover which of the 7 steps has hidden manual work.
3. **Close the tenant-scope gap** (`2026-10-27-tenant-scope-integrity.md`). 38 target
   tables, 129 edges. Additive, and it turns a review rule into a constraint.
4. **Declare outbox topic intent** (`AUDIT_ONLY_TOPICS`). 14 topics, ~1 hour.
5. **Resolve C-2 and C-3** (agent call cardinality, party identity). These are the
   two places where a wrong answer compounds: every new feature built on an
   ambiguous authority makes the ambiguity harder to unwind.
6. **Then, and only then,** archetype packs. An eval that measures whether the agent
   does a role's job well is only meaningful once the execution record it reads is
   unambiguous.

---

## 5. What the reviewer got right, and what needed checking

A prior architectural review (external, 2026-10-27) raised eight candidate problems.
Checked against code:

| Claim | Verdict |
|---|---|
| Inventory totals disagree with the per-table listing | **Correct.** My generator rendered every non-mutable row as "versioned", hiding 59 append-only tables. Fixed. |
| Cross-workspace references may not be constrained | **Correct, and worse than stated.** 0 RLS policies; 5 of 156 tables have the composite key. |
| `knowledge` owns financial truth | **Correct** (C-4). |
| Person/contact may duplicate identity | **Correct as a risk** (C-3); not yet proven to diverge. |
| Agent run/execution and call/invocation cardinality unclear | **Correct** (C-2). |
| Approval can authorise changed content | **Incorrect.** `action_reviews.revision_id` is a NOT NULL FK; the binding holds. |
| Outbox topics without handlers may be 14 bugs | **Half right.** All 14 are audit-paired; the defect is the missing declaration, not missing work. |
| Daybook may duplicate tasks/documents | **Not found.** `daybook` owns one table, `day_artifact_pins` — curation only. |

It also asserted a "latest commit" and migration-history concerns it had not
verified. Neither is recorded here as a finding.
