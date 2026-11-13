# billing

Owns: which key and model serve a model call, the weekly free allowance, the plan, the workspace's own provider keys, and the usage ledger. No payment processor yet.

- `resolver.ts` is the only place that picks a key. Every call site asks it (chat steps, generation and grading, direct SDK calls, embeddings, the run-start model freeze, the model picker). Nothing else reads a provider key from env or checks a plan.
- Precedence: the workspace's own key; else the house key under the plan's weekly allowance; else `AllowanceExhaustedError` ("add your own key or upgrade").
- `plans.ts`: `free` (house model, `FREE_WEEKLY_AI_CALLS`), `pro` (`PRO_WEEKLY_AI_CALLS`, switched on by the workspace owner by hand), `own-key` (derived: a free workspace holding a key). The week is UTC, Monday to Monday.
- `keys.ts`: keys are sealed with `lib/secret-box.ts`, proven by one test call before saving, and returned to the client only as the last four characters.
- `ledger.ts`: one append-only row per model call (workspace, provider, model, tokens, price, own or house). The allowance is derived from house rows, never stored. Embeddings are recorded but not counted.
- Prices live on the catalog entries in `agents/models.ts`; a model without one fails `tests/unit/model-prices.test.ts`.
