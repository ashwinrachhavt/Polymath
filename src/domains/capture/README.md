# capture

Owns: captures and their classification proposals

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across
. Enum values are the contract: add a value, never
repurpose one.
