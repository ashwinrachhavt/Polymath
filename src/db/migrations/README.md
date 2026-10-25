# Migrations

Forward-only SQL, one file per change, applied in glob order (CI applies them
with `psql`; Vercel does not apply them on deploy). The convention lives in
agents/engineering.md; this note covers the snapshot chain under `meta/`.

## The 2026-10-25 chain repair (ASH-316)

`drizzle-kit generate` builds its diff from the LAST journal entry's snapshot
and validates the `prevId` walk backwards. The 0248/0249 rename repair left
`0031_snapshot.json` and `0040_snapshot.json` sharing a parent, which broke
generate repo-wide and forced hand-written migrations.

The repair keeps every `.sql` file and journal entry untouched (they are the
applied history) and fixes only the snapshot chain:

- `0040_snapshot.json` (the duplicate-parent node) is deleted;
- `0249_snapshot.json` is a full snapshot of the current schema, generated
  from the schema files themselves (`drizzle-kit generate` into a scratch
  `--out` directory), re-rooted with `prevId` pointing at `0031`.

Gaps between snapshot numbers are fine - generate reads only the last entry's
snapshot; a duplicate `prevId` is not fine. The verification after touching
`meta/`:

```
DATABASE_URL=<any> pnpm exec drizzle-kit generate --name probe
# expected: "No schema changes, nothing to migrate" - delete the probe output
```

New migrations still follow the normal flow: generate, review the SQL, number
past every migration on an open PR, and append the journal entry.
