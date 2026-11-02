# spending

Owns: rate cards, spending policies, reservations, settlements, the usage
pricing history backfill (`backfill.ts`, run manually via
`pnpm backfill:usage-pricing` — idempotent, no cron).

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across domains
. Enum values are the contract: add a value, never
repurpose one.
