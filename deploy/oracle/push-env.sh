#!/usr/bin/env bash
# Copies the laptop's .env + .env.local to /opt/polymath/.env on the server
# (mode 600), rewritten for production. Prints key names at most, never values.
#
#   deploy/oracle/push-env.sh [repo-root]   (default: the main checkout)
#
# Merge order matches Next.js: .env.local wins over .env, last duplicate wins.
# Dropped: test/dev-only keys, Langfuse, and every URL that pointed at the
# laptop. Added: production mode, the in-network service URLs and the tunnel
# origin. Internal-only secrets are the server's own, never the laptop's: the
# Postgres password, the two eve token secrets and the key that seals stored
# provider keys are generated on the server
# on the first push and kept on later ones (the database volume was
# initialised with that password; changing the eve secrets would only
# invalidate in-flight agent runs).
#
# Nothing is written on the laptop; the server writes a mode-600 temp file
# next to the target and renames it.
#
# Takes effect on the next deploy (deploy.sh), which recreates the containers.
# deploy/oracle/env.example lists every key by name.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

root="${1:-$(cd "$(git -C "$here" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)}"
for f in "$root/.env" "$root/.env.local"; do
  [ -f "$f" ] || { echo "missing $f" >&2; exit 1; }
done

drop='^(DATABASE_URL|TEST_DATABASE_URL|POLYMATH_DEV_AUTH|NODE_ENV|APP_ORIGIN|NEXT_PUBLIC_APP_URL|DOCLING_SERVE_URL|SEARXNG_URL|FIRECRAWL_API_URL|POLYMATH_GATEWAY_URL|POLYMATH_DB_PASSWORD|EVE_BRIDGE_SECRET|EVE_GATEWAY_SECRET|SECRETS_ENCRYPTION_KEY|LANGFUSE_[A-Z0-9_]*|AXIOM_LOCAL_BLOB_DIR|POLYMATH_OBJECT_STORE|POLYMATH_ALLOWED_EMAILS)$'

# Last occurrence of each KEY=value line wins; order of first appearance kept.
merged="$(cat "$root/.env" "$root/.env.local" | awk -v drop="$drop" '
  /^[[:space:]]*(#|$)/ { next }
  /^[A-Za-z_][A-Za-z0-9_]*=/ {
    key = substr($0, 1, index($0, "=") - 1)
    if (key ~ drop) next
    if (!(key in line)) order[++n] = key
    line[key] = $0
  }
  END { for (i = 1; i <= n; i++) print line[order[i]] }
')"

origin="$ORACLE_PUBLIC_URL"
# The script travels as an argument so stdin is free for the values, which
# never appear on a command line or in a process listing.
# (read -d '' rather than $(cat <<...): macOS bash 3.2 misparses quotes in a
# heredoc inside command substitution.)
read -r -d '' remote <<'REMOTE' || true
set -euo pipefail
umask 077
home=/opt/polymath
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 755 "$home"
# The server's own value for KEY if it has one, else a fresh random one.
own() {
  local v=""
  [ -f "$home/.env" ] && v="$(grep -m1 "^$1=" "$home/.env" | cut -d= -f2- || true)"
  [ -n "$v" ] || v="$(openssl rand -hex "$2")"
  printf '%s' "$v"
}
pw="$(own POLYMATH_DB_PASSWORD 24)"
bridge="$(own EVE_BRIDGE_SECRET 32)"
gateway="$(own EVE_GATEWAY_SECRET 32)"
# Seals workspace-held provider keys at rest (src/lib/secret-box.ts): 32 random
# bytes as base64. Changing it makes every stored key unreadable, so it is
# generated once on the server and never replaced.
sealing=""
[ -f "$home/.env" ] && sealing="$(grep -m1 '^SECRETS_ENCRYPTION_KEY=' "$home/.env" | cut -d= -f2- || true)"
[ -n "$sealing" ] || sealing="$(openssl rand -base64 32)"
# The optional invite list is the server's own (README "Invite only"): kept
# across pushes when set on the VM, never copied from the laptop. Off unless
# someone adds it there.
allowed=""
[ -f "$home/.env" ] && allowed="$(grep -m1 '^POLYMATH_ALLOWED_EMAILS=' "$home/.env" | cut -d= -f2- || true)"
tmp="$(mktemp "$home/.env.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
{
  cat
  echo
  echo "# --- server overrides (deploy/oracle/push-env.sh) ---"
  echo "NODE_ENV=production"
  echo "POLYMATH_DB_PASSWORD=$pw"
  echo "EVE_BRIDGE_SECRET=$bridge"
  echo "EVE_GATEWAY_SECRET=$gateway"
  echo "SECRETS_ENCRYPTION_KEY=$sealing"
  echo "DATABASE_URL=postgresql://axiom:$pw@db:5432/axiom"
  echo "APP_ORIGIN=$ORIGIN"
  echo "NEXT_PUBLIC_APP_URL=$ORIGIN"
  echo "DOCLING_SERVE_URL=http://docling:5001"
  echo "SEARXNG_URL=http://searxng:8080"
  echo "FIRECRAWL_API_URL=http://firecrawl:3002"
  echo "POLYMATH_GATEWAY_URL=http://web:3000"
  # Uploads on the blobs volume (compose.oracle.yaml), unless the laptop env
  # carries a Vercel Blob token, which wins.
  echo "POLYMATH_OBJECT_STORE=local-disk"
  echo "AXIOM_LOCAL_BLOB_DIR=/data/blobs"
  if [ -n "$allowed" ]; then echo "POLYMATH_ALLOWED_EMAILS=$allowed"; fi
} > "$tmp"
chmod 600 "$tmp"
mv "$tmp" "$home/.env"
echo "wrote $home/.env: $(grep -c '=' "$home/.env") keys, mode $(stat -c %a "$home/.env"), owner $(stat -c %U "$home/.env")"
REMOTE
printf '%s\n' "$merged" | oracle_ssh "ORIGIN=$(printf %q "$origin") bash -c $(printf %q "$remote")"
