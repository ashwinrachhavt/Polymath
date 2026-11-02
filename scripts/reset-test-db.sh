#!/bin/sh
# Build a test database exactly the way CI does, so `pnpm test` means the same
# thing here as it does there.
#
# Why this exists: CI creates a fresh database and applies every migration in
# journal order, then runs vitest against it. A developer's long-lived
# axiom_test drifts from that — rows accumulate, TRUNCATEs from other suites
# reorder what is present, and a table dropped by a later migration can still
# be there. A defect that only appears on a clean chain (or only on a dirty
# one) then passes locally and fails CI, or the reverse.
#
# The db, integration and migration suites are the ones that prove schema
# behaviour, and they are exactly the ones that skip when there is no database.
# Rebuilding first is what makes a green local run mean something.
#
# The suites read TEST_DATABASE_URL (tests/setup.load-env.ts), so that is the
# database this script rebuilds when it is set — from the environment first,
# then the same env files the app loads. Without it the target falls back to
# $TEST_DB on the DATABASE_URL server, the CI-shaped default.
#
#   sh scripts/reset-test-db.sh              # drop, create, migrate
#   TEST_DB=other_db sh scripts/reset-test-db.sh
#   TEST_DATABASE_URL=postgres://.../branch_db sh scripts/reset-test-db.sh
set -e

TEST_DB="${TEST_DB:-axiom_test}"

# Load the same env files the app does when nothing set them, so the script
# works standalone as well as from a pnpm script. `|| true` keeps a variable
# no file declares from tripping set -e; an empty result means not found.
if [ -z "$DATABASE_URL" ]; then
  for envfile in .env.local .env; do
    if [ -f "$envfile" ]; then
      DATABASE_URL=$(sed -nE 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$envfile" | head -1 | sed -E 's/^["'\'']//; s/["'\'']$//') || true
      [ -n "$DATABASE_URL" ] && export DATABASE_URL && break
    fi
  done
fi

if [ -z "$TEST_DATABASE_URL" ]; then
  for envfile in .env.local .env; do
    if [ -f "$envfile" ]; then
      TEST_DATABASE_URL=$(sed -nE 's/^[[:space:]]*TEST_DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$envfile" | head -1 | sed -E 's/^["'\'']//; s/["'\'']$//') || true
      [ -n "$TEST_DATABASE_URL" ] && export TEST_DATABASE_URL && break
    fi
  done
fi

# Reset the database the suites actually read: TEST_DATABASE_URL when set,
# else TEST_DB on the DATABASE_URL server.
if [ -n "$TEST_DATABASE_URL" ]; then
  TARGET_URL="$TEST_DATABASE_URL"
elif [ -n "$DATABASE_URL" ]; then
  TARGET_URL=$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\\?.*)?\$#/$TEST_DB\\1#")
else
  echo "TEST_DATABASE_URL (or DATABASE_URL) is not set; add one to .env or export it." >&2
  exit 1
fi

# This script drops the target database, so a TEST_DATABASE_URL that matches
# the application DATABASE_URL must abort before psql runs — the shell-side
# twin of tests/helpers/app-db-safety.ts, which guards the same boundary for
# the truncating suites.
if [ -n "$DATABASE_URL" ] && [ "$TARGET_URL" = "$DATABASE_URL" ]; then
  echo "reset-test-db: refusing to drop the application database — the reset target equals this environment's DATABASE_URL (check both the shell export and .env)." >&2
  exit 1
fi

# Admin connection: the same server, but the maintenance database, so the target
# can be dropped while nothing is attached to it.
ADMIN_URL=$(printf '%s' "$TARGET_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres\1#')

# Name only — the URL carries credentials and must never be echoed.
TARGET_DB=$(printf '%s' "$TARGET_URL" | sed -E 's#^.*/##; s#\?.*$##')

echo "reset-test-db: dropping and recreating $TARGET_DB"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$TARGET_DB\"" \
  -c "create database \"$TARGET_DB\""

echo "reset-test-db: applying $(ls src/db/migrations/*.sql | wc -l | tr -d ' ') migrations in journal order"
for f in src/db/migrations/*.sql; do
  if ! psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
    echo "reset-test-db: migration failed: $f" >&2
    psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$f" >&2 || true
    exit 1
  fi
done

echo "reset-test-db: $TARGET_DB is at the head of the chain"
