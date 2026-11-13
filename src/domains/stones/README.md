# stones

Owns coins and the stone collection: the coin ledger, the 200-stone catalog, who owns which stone, and the earning rules. Tables are in `schema.ts`; UI reads through `queries.ts`.

## The loop

Finishing a quiz, a flashcard rating, a mission mock interview or a task earns coins. Coins buy stones from a fixed catalog of 200 real minerals, priced by tier (legendary: diamond and gold; then precious, semi-precious, crystals). The quest is the full set.

## Invariants

- `coin_ledger` is the only record of coins. A balance is `sum(amount)` over a person's rows (workspace + user); nothing stores a balance. Rows are append-only.
- Every row's `idempotency_key` names the event that caused it and is unique per person, so a replayed completion or purchase cannot move a balance twice.
- Earning rows are positive; a purchase (`stone_purchased`) is the only negative row (a check constraint).
- Every write first takes the person's coin lock (`pg_advisory_xact_lock` on `coins:<workspace>:<user>`), so a balance check, a daily ceiling and the row written after it cannot interleave with another write for the same person. A balance therefore never goes below zero.
- `buyStone` writes the debit and the `stone_ownership` row in one transaction; owning a stone twice is impossible (unique per person and stone), and a second buy of an owned stone reports it and charges nothing.
- Awards are written by `awardCoins` inside the transaction that records the completion, so coins commit with the completion or not at all.

## Earning rules (`awards.ts`)

Each completion has a score from 0 to 1 and pays `base + forScore × score`:

| Completion             | Pays                                                        | Paid at most             | Daily ceiling |
| ---------------------- | ----------------------------------------------------------- | ------------------------ | ------------- |
| Quiz (3+ questions)    | 10 + 40 × share correct (server-graded)                     | once per quiz per day    | 200           |
| Flashcard rating       | 2, whatever the rating (self-rated, so "easy" pays no more) | once per card per day    | 60            |
| Mission mock interview | 30 + 120 × share of questions proven correct                | once per mission per day | 300           |
| Task done              | 5                                                           | once per task, ever      | 50            |

An award that would pass the day's ceiling pays only what is left. Days are the person's timezone (`user_preferences`, else UTC).

## Catalog

`scripts/stones/catalog.json` is the authoring source; migration 0321 seeds `stones` from it (`scripts/stones/catalog-sql.ts`). Corrections are an edit there plus a new migration; `tests/integration/stones-economy.test.ts` keeps table and file equal. Art is `public/stones/<slug>.webp`, drawn by `scripts/stones/generate_art.py` (Gemini image model, resumable, hard spend cap, cost per stone in `scripts/stones/art-spend.json`); the script keeps `src/components/stones/drawn-stones.json` current, and a stone not in it shows a placeholder in its own color, so the set works with any number of drawings. `lore` is folklore and the UI labels it so.

## What replaced what

Migration 0321 dropped the old reward system (`reward_definitions`, `reward_ledger`, `user_progress`). Each person's old points became coins 1:1 in one `legacy_rewards` row. Focus sessions no longer pay.
