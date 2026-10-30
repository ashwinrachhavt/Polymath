# TODOS

## Capture & Classification

**Priority:** P1
- [ ] Backfill retired taxonomy slugs in existing captures.domain rows (ai→coding-development, finance→finance-admin, …) or mark the column write-once provenance in schema docs. *(from data-migration review, 2026-10-28)*
- [ ] Add the taxonomy seed to the post-merge deploy checklist; print per-workspace before/after node counts in the seed script. *(from data-migration review, 2026-10-28)*

**Priority:** P2
- [ ] Prompt-injection framing for mention context: label CRM notes as imported data, not instructions. *(from security review, 2026-10-28)*

## Auth & Routing

**Priority:** P2
- [ ] Taxonomy seed should print a warning when a workspace still carries retired slugs after a run. *(from data-migration review, 2026-10-28)*


## Ideas / Sittings (zettels)

**Priority:** P1
- [ ] commitDecompositionAction trusts the client's analysis payload (z.unknown cast) — re-validate server-side (cap, verbatim spans, bounded decisions array) or an attacker mints unbounded tasks. *(from adversarial review, 2026-10-30)*
- [ ] HTTP-level test for the create-stream route: reconnect cursor semantics, foreign-workspace 404 parity, payload→event replay filtering. *(from /ship coverage + plan audits, 2026-10-30)*
- [ ] Ambient panel Retry is state-reset only — wire it to re-fire the failed stage (§15.3 recovery contract), plus its test. *(from plan audit, 2026-10-30)*
- [ ] Rotate the companion machine key (axm_0PV9…) — it has lived in the repo; mint a new one and update the extension. *(from pre-landing review, 2026-10-30)*

**Priority:** P2
- [ ] Client never sends x-sitting-cursor on reconnect (server path is dead code; drops recover via next pause). *(from pre-landing review, 2026-10-30)*
- [ ] §16.9 background-tab throttle-pinning test; §11 double-submit-creates-one-artifact named test. *(from plan audit, 2026-10-30)*
- [ ] Attached streams hang when a run ends without a `done` fanout (abort/stall/sweep paths write DB only); add a terminal fanout or attach-side timeout. *(from adversarial review, 2026-10-30)*
- [ ] Migration 0262's unique index fails the deploy if pre-0262 races left duplicate RUNNING rows; add a pre-index dedupe or document the cleanup. *(from adversarial review, 2026-10-30)*
- [ ] Bloom projection in zettels.ts (metadata stripped, bloom extracted) unasserted. *(from coverage audit, 2026-10-30)*
- [ ] Sitting deletion exists in the domain + tests but no server action or UI exposes it. *(from plan audit, 2026-10-30)*

**Priority:** P3
- [ ] Coverage: writing-surface firePaste/adopt/hydration suppression, idea-editor save flow, extension pairing flow, ambient-panel render states. *(from coverage audit, 2026-10-30)*
- [ ] Two pre-existing main-branch e2e failures (axe pill-success contrast on work rail; design-brief-canva "Filter by status" timeout) — owned outside this branch. *(from /ship CI triage, 2026-10-30)*

## Completed
