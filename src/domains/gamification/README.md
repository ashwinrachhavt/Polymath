# gamification

Owns: reward definitions, the append-only reward ledger, progress projections, daily snapshots

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
(agents/engineering.md). Enum values are the contract: add a value, never
repurpose one.
