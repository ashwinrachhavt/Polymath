#!/bin/sh
set -eu

# Bind mounts provide the source tree, but /app/node_modules is a named volume
# so native deps match this container. Install on first boot or when the
# lockfile changes.
LOCK_HASH_FILE=/app/node_modules/.pnpm-lock.hash
LOCK_HASH="$(sha256sum /app/pnpm-lock.yaml 2>/dev/null | awk '{print $1}' || echo none)"

if [ ! -d /app/node_modules/.pnpm ] || [ ! -f "$LOCK_HASH_FILE" ] || [ "$(cat "$LOCK_HASH_FILE" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  echo "docker: installing dependencies..."
  pnpm install --frozen-lockfile=false
  mkdir -p /app/node_modules
  printf '%s' "$LOCK_HASH" > "$LOCK_HASH_FILE"
fi

exec "$@"
