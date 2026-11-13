#!/usr/bin/env bash
# Opens the app at http://localhost:3300 through SSH. Ctrl-C closes it.
# The VM publishes nothing new: web listens on its loopback only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

echo "Polymath on Oracle: http://localhost:${ORACLE_TUNNEL_PORT}  (Ctrl-C to close)"
exec ssh -i "$ORACLE_SSH_KEY" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -N -L "${ORACLE_TUNNEL_PORT}:127.0.0.1:3000" "$ORACLE_HOST"
