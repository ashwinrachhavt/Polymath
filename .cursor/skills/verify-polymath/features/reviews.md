# Reviews

What it is: the approvals queue at `/reviews`. When a run asks for a proposal, the decision waits here. Reviews owns the waiting-on-you vocabulary; no other screen says "needs you".

## Sub-features

- The queue of runs waiting on the user (`waiting_approval` state, pending proposals per run via `listRunPendingProposals`).
- Acting on a proposal: approve or reject from the queue. The acting controls belong to this surface, not to the conversation page.

## How to get to it (user POV)

The rail entry "Reviews" leads to `/reviews`. A conversation never links there by state word; it stays a conversation.

## Driving it with agent-browser

1. Seed a run with state `waiting_approval` using the `tests/e2e/helpers/runs.ts` pattern. This state exists only as a seeded row: the product reaches it after a model asks for a proposal, and this sandbox has no model provider. Register the row for deletion.
2. Open `http://localhost:3000/reviews`. Verify the seeded run surfaces in the queue under the waiting-on-you vocabulary.
3. If the journey needs a proposal behind the run, use `tests/e2e/helpers/proposals.ts` to seed one.
4. Capture the queue state to `/home/user/work/evidence/verify-polymath/`.

## Gotchas

- A bare seeded run has no proposal attached, so a proposal card is not part of the proof unless you seed one.
- The conversation page shows no status badge even when the run is waiting. Asserting "Needs your reply" there must find zero of them; that copy belongs to Reviews.
- Several e2e specs drive this surface (`tests/e2e/github-triage.spec.ts`, `design-brief.spec.ts`, `notion-diff.spec.ts`, `crm-sender-switch.spec.ts`). Read one for the current list copy before asserting on it.
