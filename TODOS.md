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

## Daybook

**Priority:** P1
- [ ] Integration test for the pin-remove path (`unpinArtifactFromDay`): pin → unpin → Kept list empty → repeat unpin is a quiet no-op. *(from state-machines review, 2026-10-30; pre-existing gap, deferred from this ship)*

**Priority:** P2
- [ ] Derive the timeline's PINNABLE_KINDS from the knowledge schema's artifact_kind enum instead of hand-copying the ten values, so a new kind is pinnable without a second edit. *(from fix-check review, 2026-10-30)*
- [ ] The day page's plan sidebar and Close-the-day panel are bound to "today" while the timeline reflects the viewed URL date; label the plan "What today is committed to" or scope it to the viewed date. *(from red-team review, 2026-10-30)*
- [ ] Week-strip chevrons dead-end at week edges (labels state the limit); consider date ± 1 day arithmetic if week-crossing is wanted. *(from red-team + state-machines review, 2026-10-30)*
- [ ] getDayPage's `limit 50` sits inside json_agg laterals, capping nothing on heavy days; select top-50 in a derived table before aggregating. *(from red-team review, 2026-10-30; pre-existing)*

## Completed
