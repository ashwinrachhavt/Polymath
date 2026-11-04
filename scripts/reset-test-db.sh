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
#   sh scripts/reset-test-db.sh              # drop, create, migrate
#   TEST_DB=other_db sh scripts/reset-test-db.sh
#
# The database reset is the one named by TEST_DATABASE_URL when that is set
# (the variable the integration and e2e suites standardize on — e.g. the
# private per-run/per-shard database an e2e run expects, see
# tests/e2e/README.md); TEST_DB overrides, axiom_test is the fallback.
set -e

TEST_DB="${TEST_DB:-}"
if [ -z "$TEST_DB" ] && [ -n "${TEST_DATABASE_URL:-}" ]; then
  # Everything after the last slash, query string stripped. Only trust it when
  # it is a bare identifier — a URL without a db path would yield garbage.
  TEST_DB=$(printf '%s' "$TEST_DATABASE_URL" | sed -E 's#\?.*$##; s#.*/##')
  case $TEST_DB in
    *[!A-Za-z0-9_]*) TEST_DB="" ;;
  esac
fi
TEST_DB="${TEST_DB:-axiom_test}"

# Connect to the server that owns the target database: TEST_DATABASE_URL when
# given, else the app's DATABASE_URL.
if [ -n "${TEST_DATABASE_URL:-}" ]; then
  DATABASE_URL="$TEST_DATABASE_URL"
fi

# Load the same env files the app does when nothing set them, so the script
# works standalone as well as from a pnpm script.
if [ -z "$DATABASE_URL" ]; then
  for envfile in .env.local .env; do
    if [ -f "$envfile" ]; then
      DATABASE_URL=$(sed -nE 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$envfile" | head -1 | sed -E 's/^["'\'']//; s/["'\'']$//')
      [ -n "$DATABASE_URL" ] && export DATABASE_URL && break
    fi
  done
fi

if [ -z "$DATABASE_URL" ]; then
  echo "DATABASE_URL is not set; add it to .env or export it." >&2
  exit 1
fi

# Admin connection: the same server, but the maintenance database, so the target
# can be dropped while nothing is attached to it.
ADMIN_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#/[^/?]+(\?.*)?$#/postgres\1#')

echo "reset-test-db: dropping and recreating $TEST_DB"
# with (force) (PG13+) terminates connections still attached to the target —
# the previous run's dev server, say — instead of failing the reset. On a
# service with no connections (CI) it is a no-op.
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c "drop database if exists \"$TEST_DB\" with (force)" \
  -c "create database \"$TEST_DB\""

TARGET_URL=$(printf '%s' "$DATABASE_URL" | sed -E "s#/[^/?]+(\\?.*)?\$#/$TEST_DB\\1#")

echo "reset-test-db: applying $(ls src/db/migrations/*.sql | wc -l | tr -d ' ') migrations in journal order"
for f in src/db/migrations/*.sql; do
  if ! psql "$TARGET_URL" -v ON_ERROR_STOP=1 -q -f "$f" >/dev/null 2>&1; then
    echo "reset-test-db: migration failed: $f" >&2
    psql "$TARGET_URL" -v ON_ERROR_STOP=1 -f "$f" >&2 || true
    exit 1
  fi
done

echo "reset-test-db: $TEST_DB is at the head of the chain"
