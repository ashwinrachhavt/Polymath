# Migrations

Forward-only SQL, one file per change, applied in glob order (CI applies them
with `psql`; the Vercel deploy applies them with `drizzle-kit migrate` before
compiling — see `buildCommand` in `vercel.json`, which needs `DATABASE_URL`
exposed to the build environment). The convention lives in
the engineering guidelines; this note covers the snapshot chain under `meta/`.

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

## The one-snapshot invariant

Only the newest snapshot is tracked — the one matching the journal's last
entry (currently `0270_snapshot.json`); every other snapshot under `meta/` is
gitignored, which keeps ~13.4 MB of ~600k lines out of every checkout.
Nothing reads the older snapshots: `drizzle-kit generate` diffs against the
newest snapshot present, and everything else (`check:migrations`, CI's psql
replay, the Vercel `drizzle-kit migrate`) reads the journal and SQL files
only.

`scripts/check-snapshot-invariant.ts` — run in CI next to the append-only
guard — fails when the count of tracked snapshots is not exactly one, or when
the tracked one is not the journal's last entry.

When you generate a migration (say `0271`), roll the baseline forward:

1. flip the `.gitignore` exception from `0270` to `0271`;
2. `git rm --cached src/db/migrations/meta/0270_snapshot.json`;
3. `git add -f src/db/migrations/meta/0271_snapshot.json`.

`pnpm check:snapshot-invariant` catches each forgotten step.

### The first db:generate after this change lands

Stale local snapshots survive pulls: untracking removes them from the index,
not the working tree, and they are now ignored. A local snapshot newer than
the tracked baseline would silently become generate's diff base, so run the
first `pnpm db:generate` in a clean tree — delete the stale files first:

```
git clean -fX src/db/migrations/meta
```

(`-X` removes only ignored files, so the tracked baseline and `_journal.json`
survive.)
