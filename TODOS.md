# TODOS

## Capture & Classification

**Priority:** P1

- [ ] Backfill retired taxonomy slugs in existing captures.domain rows (ai→coding-development, finance→finance-admin, …) or mark the column write-once provenance in schema docs. _(from data-migration review, 2026-10-28)_
- [ ] Add the taxonomy seed to the post-merge deploy checklist; print per-workspace before/after node counts in the seed script. _(from data-migration review, 2026-10-28)_

**Priority:** P2

- [ ] Prompt-injection framing for mention context: label CRM notes as imported data, not instructions. _(from security review, 2026-10-28)_

## Auth & Routing

**Priority:** P2

- [ ] Taxonomy seed should print a warning when a workspace still carries retired slugs after a run. _(from data-migration review, 2026-10-28)_

## Ideas / Sittings (zettels)

**Priority:** P1

- [ ] commitDecompositionAction trusts the client's analysis payload (z.unknown cast) — re-validate server-side (cap, verbatim spans, bounded decisions array) or an attacker mints unbounded tasks. _(from adversarial review, 2026-10-30)_
- [ ] HTTP-level test for the create-stream route: reconnect cursor semantics, foreign-workspace 404 parity, payload→event replay filtering. _(from /ship coverage + plan audits, 2026-10-30)_
- [ ] Ambient panel Retry is state-reset only — wire it to re-fire the failed stage (§15.3 recovery contract), plus its test. _(from plan audit, 2026-10-30)_
- [ ] Rotate the companion machine key (axm_0PV9…) — it has lived in the repo; mint a new one and update the extension. _(from pre-landing review, 2026-10-30)_

**Priority:** P2

- [ ] Client never sends x-sitting-cursor on reconnect (server path is dead code; drops recover via next pause). _(from pre-landing review, 2026-10-30)_
- [ ] §16.9 background-tab throttle-pinning test; §11 double-submit-creates-one-artifact named test. _(from plan audit, 2026-10-30)_
- [ ] Attached streams hang when a run ends without a `done` fanout (abort/stall/sweep paths write DB only); add a terminal fanout or attach-side timeout. _(from adversarial review, 2026-10-30)_
- [ ] Migration 0262's unique index fails the deploy if pre-0262 races left duplicate RUNNING rows; add a pre-index dedupe or document the cleanup. _(from adversarial review, 2026-10-30)_
- [ ] Bloom projection in zettels.ts (metadata stripped, bloom extracted) unasserted. _(from coverage audit, 2026-10-30)_
- [ ] Sitting deletion exists in the domain + tests but no server action or UI exposes it. _(from plan audit, 2026-10-30)_

**Priority:** P3

- [ ] Coverage: writing-surface firePaste/adopt/hydration suppression, idea-editor save flow, extension pairing flow, ambient-panel render states. _(from coverage audit, 2026-10-30)_
- [ ] Two pre-existing main-branch e2e failures (axe pill-success contrast on work rail; design-brief-canva "Filter by status" timeout) — owned outside this branch. _(from /ship CI triage, 2026-10-30)_

## Missions and Stones (deferred by the 2026-11-11 CEO review)

**Priority:** P2

- [ ] Ask box for work-time recall: one box that answers from the user's own concept cards first and says so. Deferred until cards exist in volume (after the week-3 pilot). Depends on the question-to-concept link. _(from /plan-ceo-review, 2026-11-11, decision C1; plan in docs/plans/2026-11-11-missions-and-stones.md)_
- [ ] Unprompted daily message with today's 20-minute step. Home shows the step for now; the outbound message needs a sender, failure handling and an unsubscribe path. _(from /plan-ceo-review, 2026-11-11, decision C4)_

**Priority:** P3

- [ ] Referral stones, limited-edition stones, and a garden or temple built on the wall, once people are paying. _(from /plan-ceo-review, 2026-11-11, decision L1)_

## Completed

- [x] Capture classification proposal layer removed end-to-end: capture_proposals table dropped (migration 0288), enrichment writes the Jev domain straight to the capture row, inbox suggestion cards, home-queue capture cards, and accept/reject commands deleted. **Completed:** in-flight (2026-11-05)
