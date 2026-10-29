# identity

Owns: users, workspaces, memberships, preferences, api clients

`users` and `workspaces` live in `tables.ts` rather than `schema.ts`: they are
the root of the import graph, and `src/db/columns.ts` needs `workspaces` to
build every other table's `workspace_id` foreign key.

Tables are in those two files and nowhere else — a domain owns its tables, and
UI code reads them through this domain's queries rather than joining across
.
