# learning

Owns: decks, items, attempts, plans.

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
(agents/engineering.md). Enum values are the contract: add a value, never
repurpose one.

## Contract

- `commands.ts` — `createDeck`, `generateQuiz`, `approveItem`, `approveItems`,
  `retireItem`, `recordAttempt`. Every write is one transaction with an audit
  row; `recordAttempt` is idempotent under a supplied receipt key.
- `queries.ts` — `listDecks`, `dueItems`, `proposedItems`, `getItem`,
  `itemAttempts`, `deckProgress`. All workspace-scoped.
- `sm2.ts` — the scheduling arithmetic, pure. `ease_factor` is stored as text
  by the v1 table, so `parseEase` is the one place it becomes a number.
- `src/integrations/quiz/generator.ts` — the model-facing seam. It returns
  candidates; `verifyCandidates` drops any whose quote is not verbatim in the
  source, so a model cannot invent evidence.

## The rule that keeps this honest

Generation writes `proposed`. Only `approveItem`/`approveItems` writes
`approved`. Only an `approved` item is ever due and only an `approved` item can
be reviewed. "I made a quiz" never reads as "I know this".

