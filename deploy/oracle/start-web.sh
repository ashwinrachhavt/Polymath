#!/usr/bin/env bash
# The web container's entry: both built eve agents, then `next start`.
#
# eve/next would start the agents itself from the rewrites() hook, but
# `next start` serves rewrites from the build manifest and never calls it, so
# the agents' loopback ports stayed closed and every /eve/<agent>/v1 request
# failed. The ports are the ones `next build` baked into those rewrites:
# 4274 + the agent's position in withEve's `agents` (next.config.ts).
#
# If any of the three processes exits, the others are stopped and the
# container exits, so Docker's restart policy brings all three back together.
set -euo pipefail

start_agent() {
  local name="$1" port="$2"
  (
    cd "/app/eve/$name"
    exec env HOST=127.0.0.1 NITRO_HOST=127.0.0.1 PORT="$port" NITRO_PORT="$port" node .output/server/index.mjs
  ) &
}

trap 'kill 0 2>/dev/null; exit 143' TERM INT

start_agent polymath 4274
start_agent specialist 4275
pnpm start --hostname 0.0.0.0 --port 3000 &

wait -n
status=$?
echo "start-web: a process exited (status $status); stopping the rest" >&2
kill 0 2>/dev/null || true
exit "$status"
