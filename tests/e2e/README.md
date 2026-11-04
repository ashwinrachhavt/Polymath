# E2E suite

Journeys, not pages — Playwright drives the real app (`next dev`, keyless dev
auth) through a browser. `playwright.config.ts` boots the server itself;
set `E2E_BASE_URL` to point the suite at an already-running one instead.

## Private-DB pattern: reset before you drive

Every spec in a run shares one database, and writes accumulate — `reward_ledger`
is append-only, workspaces and rows persist. A spec that assumes a pristine
workspace reads whatever the previous spec (or the previous run) left behind,
which is how order-dependent failures happen. So each e2e run gets a fresh
private database, provisioned by the same script CI uses:

```sh
export DATABASE_URL=postgresql://axiom:axiom@127.0.0.1:5432/e2e_local
export TEST_DATABASE_URL=$DATABASE_URL
# On a laptop whose .env holds real Clerk keys, the proxy enforces sessions and
# bounces every journey to /landing — CI has no keys, so its keyless dev-auth
# path engages automatically. Locally, ask for the bypass explicitly:
export POLYMATH_DEV_AUTH=1
sh scripts/reset-test-db.sh                # drops, recreates, migrates the db named by TEST_DATABASE_URL
pnpm exec playwright test tests/e2e/<spec>.spec.ts
```

- The script resets the database named by `TEST_DATABASE_URL` (override the
  name with `TEST_DB=...`). `DATABASE_URL` is what the booted server and
  `global-setup` read, so point both at the same private db.
- Never point either at your dev database: the suite writes (ledger rows,
  reward definitions, the dev owner's workspace). Use a name you can drop.
- Re-running? Reset again — that is the pattern: each run starts from an empty
  schema at the head of the migration chain, not from yesterday's rows.
- CI does this per shard: each e2e job provisions `axiom_e2e_shard<1..3>` via
  `scripts/reset-test-db.sh` on its own postgres service, so no shard shares
  rows with its siblings or with a previous run.

The same script backs `pnpm test:ci` (the vitest integration suites). One
provisioning mechanism everywhere: CI is never fresher or staler than a local
run of the same commit.
