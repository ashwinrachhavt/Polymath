# work

Owns: spaces, projects, tasks, dependencies, links, boards, columns, saved views, daily outcomes, recurrence templates

Tables are in `schema.ts` and nowhere else — a domain owns its tables, and UI
code reads them through this domain's queries rather than joining across domains
. Enum values are the contract: add a value, never
repurpose one.

## Task commands (A03, ASH-137)

`commands.ts` holds the original create/complete pair; `task-commands.ts` holds
the rest of the owner's task mutations: `updateTask` (version compare-and-set),
`createSubtask` (one level), `moveTask` (fractional rank between neighbours),
`addDependency` / `addWaitingOn` / `removeDependency`. Each is one transaction
with an idempotency receipt (`audit/receipt.ts`), an audit row, and an outbox
event. Ranks sort bytewise: always `order by rank collate "C"`. Recurrence and
the daily-outcome model are the next PR; the Work screens still read the
browser-only preview until the UI is wired to these commands.
