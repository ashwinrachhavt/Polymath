# Assistant conversations

What it is: the home of the product. A user types an objective, the run behind it becomes a conversation, and the transcript page is where they read it, follow up, or cancel. "Runs" is the internal name (table `agent_runs`); the screens say conversation.

## Sub-features

- Conversation home at `/polymath`: the greeting h1 "What would you like to work on?", one composer ("Start a conversation"), and recent conversations as history rows.
- Conversation detail at `/polymath/[runId]`: the transcript in a region named "Conversation", a follow-up composer and stop control for live runs, the draft the run produced, and the recorded-usage cost line.
- Starting work: the home composer, or `POST /api/v1/runs` with body `{"objective": "..."}` and an `Idempotency-Key` UUID header. Both go through the Eve bridge; without its secrets the API answers 503 `agent_bridge_unavailable`. The start is idempotent per key: a retry returns the first run, and a second start with the same key while the first is in flight answers 409.

## How to get to it (user POV)

Sign in and you are already here: the root redirects to `/polymath`. History rows link to `/polymath/<run id>`. The rail's "Polymath" entry returns to the home.

## Driving it with agent-browser

The deterministic path needs no model. It mirrors `tests/e2e/smoke.spec.ts`, which owns this surface in CI.

1. Seed a conversation the way `tests/e2e/helpers/runs.ts` does: insert into `agent_runs` for the dev owner's workspace, state `waiting_approval` (the state the CI smoke test seeds, because it renders without a model), an objective that names the verification, and keep the returned id. Register it for deletion.
2. Open `http://localhost:3000/polymath/<run id>`. Verify the h1 is the objective text, the "Conversation" region is visible, and it reads "This conversation has no messages yet.". A waiting run is live from the page's point of view, so the composer offers a follow-up and a stop.
3. Open `http://localhost:3000/polymath`. Verify the h1, and that a history row named by the objective links to `/polymath/<run id>`.
4. Capture both states to `/home/user/work/evidence/verify-polymath/`.

The real user path (exercises the start flow, not the transcript) is typing into the composer or calling `POST /api/v1/runs`. The run starts, but its transcript will not progress without a model provider, so use it to verify the start contract, then move on.

## Gotchas

- Assert content, never HTTP status. A run id from another workspace answers 200 with not-found content, because `loading.tsx` commits before `notFound()` runs.
- Scope assertions to the first `#content`. In dev the streamed subtree can be mounted twice.
- `/polymath/*` screens are headerless: there is no "Search workspace" trigger to wait on.
- History rows must not read as debug lines: no status words, no model name, no "You:" or "Assistant:" transcript prefixes. This is asserted in CI and the seeded row must honor it.
- Delete seeded rows after the journey. Leftover rows fill Recent and slow every later journey (the suite's own cleanup rule).
