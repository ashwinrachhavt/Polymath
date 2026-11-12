# Shared by the laptop-side scripts in this folder. Sourced, not run.
#
# The server's address lives outside this public repo, in
# ~/.config/polymath/oracle.env (or wherever ORACLE_CONFIG points):
#
#   ORACLE_HOST=ubuntu@<vm public ip>
#   ORACLE_SSH_KEY=$HOME/.ssh/oci_docling
#   ORACLE_PUBLIC_URL=https://polymath.<vm ip with dashes>.sslip.io

ORACLE_CONFIG="${ORACLE_CONFIG:-$HOME/.config/polymath/oracle.env}"
# shellcheck disable=SC1090
[ -f "$ORACLE_CONFIG" ] && . "$ORACLE_CONFIG"
: "${ORACLE_HOST:?set ORACLE_HOST (user@ip) in $ORACLE_CONFIG}"
ORACLE_SSH_KEY="${ORACLE_SSH_KEY:-$HOME/.ssh/oci_docling}"
ORACLE_HOME_DIR=/opt/polymath
# Local end of the tunnel. Not 3000: the laptop's own Docker stack owns it.
ORACLE_TUNNEL_PORT="${ORACLE_TUNNEL_PORT:-3300}"
# The app's origin: the public HTTPS name when there is one (README "Public
# access"), otherwise the tunnel.
ORACLE_PUBLIC_URL="${ORACLE_PUBLIC_URL:-http://localhost:${ORACLE_TUNNEL_PORT}}"

oracle_ssh() {
  ssh -i "$ORACLE_SSH_KEY" -o BatchMode=yes -o ConnectTimeout=15 "$ORACLE_HOST" "$@"
}
