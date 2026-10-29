# integrations

Owns: integration catalog, external accounts, sync cursors, triggers

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across domains
. Enum values are the contract: add a value, never
repurpose one.
