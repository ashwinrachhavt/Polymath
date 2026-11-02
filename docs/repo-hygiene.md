# Repo hygiene guards

Three CI guards keep the repo's weight and shape honest. All fail the build —
none warn — so the lessons already paid for (13.4 MB of migration snapshots
rode in every checkout for months) are enforced by structure, not memory.

| Guard | Script | Fails when |
|---|---|---|
| Append-only migration checkpoints | `scripts/check-migrations.ts` | An applied migration's journal row or SQL is edited or deleted |
| Snapshot invariant | `scripts/check-snapshot-invariant.ts` | The tracked snapshot count is not exactly one, or it is not the journal's last entry |
| Repo hygiene | `scripts/check-repo-hygiene.ts` | A tracked blob exceeds 256 KB outside the allowlist, or a generated/local artifact path is tracked |

All three run in the `check-tests` job of `.github/workflows/ci.yml`, one
after the other, before the SQL replay.

## Size ceiling (deny-by-default)

Any tracked blob over **256 KB** fails unless a line in `SIZE_ALLOWLIST`
matches it. The allowlist is deliberate, not a convenience: a new large file
needs a PR that argues for its line. Today's lines:

| Line | Why |
|---|---|
| `pnpm-lock.yaml` | Generated, but the lockfile must be tracked |
| `src/db/migrations/**` | Converge migrations are legitimately large SQL |
| `src/db/migrations/meta/*_snapshot.json` | The one tracked baseline snapshot (see the snapshot invariant) |
| `tests/fixtures/**` | Sanitized fixtures can be large by construction |
| `extensions/**` | Vendored browser-extension code |

Anything regenerable (model dumps, API responses, exported datasets) should be
generated locally, not committed. To allowlist: add a path-anchored glob to
`SIZE_ALLOWLIST` in `scripts/check-repo-hygiene.ts` (only `**` spanning
segments and a single-segment `*` are supported), state the justification in
the PR, and delete the line if the file ever leaves.

## Generated-artifact blocklist

`.next/`, `build/`, `dist/`, `coverage/`, `.turbo/`, `*.tsbuildinfo` and
`.DS_Store` fail the guard at any size, at any depth — `dist/` matches
`packages/app/dist/…` as readily as a top-level `dist/`. They are
machine-local build output: `.gitignore` is the first line of defense and the
blocklist is the backstop when a `git add -f` or a missing ignore line slips
one through. Remove with `git rm --cached <path>`.

Snapshot multiplicity is deliberately **not** duplicated here: the snapshot
invariant guard owns it, with the richer "exactly one, the journal's last
entry" rule — see `src/db/migrations/README.md`.

## Rolling the snapshot baseline forward

When a migration lands (say `0271`), the tracked baseline rolls with it:

1. flip the `.gitignore` exception from `0270` to `0271`;
2. `git rm --cached src/db/migrations/meta/0270_snapshot.json`;
3. `git add -f src/db/migrations/meta/0271_snapshot.json`.

`pnpm check:snapshot-invariant` catches every forgotten step. The full
procedure, including the clean-tree first `db:generate`, is in
`src/db/migrations/README.md`.

## Negative test

The `check-tests` job runs the guard twice: once on the real tree (must
pass), then after staging a probe a byte over the ceiling plus a blocklisted
path (must fail, naming both) — a guard that always passes is a no-op, and
the self-test makes vacuous green impossible. The same boundary is pinned as
unit tests in `tests/unit/check-repo-hygiene.test.ts`.
