# Change specification

## Goal (L1)

User outcome, affected users, constraints, non-goals, and observable acceptance scenarios. State what would count as failure.

## Approach (L2)

Owning domain, contracts, representations, state transitions, authorization, null/absence semantics, retry behavior, and resource budgets. Include compatibility and data-retention decisions. Resolve material open decisions with the user; record rationale and alternatives.

## Implementation pointers (L3 references)

Link to current code and relevant configuration. Inspect them before implementation. Keep signatures, schema bodies, and command definitions in their original source files.

## Verification and evidence

Map each acceptance scenario to a behavioral check. Record actual commands/results, fixture or database isolation, and any unverified live-provider behavior. Include relevant failure, concurrency, and cross-workspace cases. Scale checks to the risk.

## Decisions and delivery

Record decisions with date, rationale, and superseded decision where relevant. State migration/rollout steps, final outcome, remaining limitations, and PR link when available. Distinguish planned checks from checks that actually ran.
