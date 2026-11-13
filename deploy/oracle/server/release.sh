#!/usr/bin/env bash
# Runs on the VM, called by deploy.sh over SSH. Not for the laptop.
#
#   release.sh deploy <sha>   build, back up, migrate, swap, health-check;
#                             puts the previous release back on failure
#   release.sh rollback       start the previous release again
#   release.sh status         current/previous release and container health
#
# Releases live in /opt/polymath/releases/<sha> (a git archive of the commit);
# each builds the image polymath-app:<sha>. /opt/polymath/current-release and
# previous-release record which ones served. Migrations are forward-only:
# a rollback restarts the old code, it does not undo a migration.
set -euo pipefail

home=/opt/polymath
project=polymath
keep_releases=3

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

compose() {
  local sha="$1"; shift
  sudo env POLYMATH_RELEASE="$sha" POLYMATH_HOME="$home" DOCKER_BUILDKIT=1 \
    docker compose -p "$project" --env-file "$home/.env" \
    -f "$home/releases/$sha/deploy/oracle/compose.oracle.yaml" "$@"
}

read_release() { cat "$home/$1" 2>/dev/null || true; }

render_searxng() {
  local sha="$1" secret_file="$home/searxng/secret"
  sudo install -d -m 755 "$home/searxng"
  if ! sudo test -s "$secret_file"; then
    openssl rand -hex 32 | sudo tee "$secret_file" >/dev/null
    sudo chmod 600 "$secret_file"
  fi
  sudo sed "s/__SEARXNG_SECRET__/$(sudo cat "$secret_file")/" \
    "$home/releases/$sha/scripts/local-search/searxng/settings.yml.tpl" \
    | sudo tee "$home/searxng/settings.yml" >/dev/null
  # searxng reads it as its own non-root user.
  sudo chmod 644 "$home/searxng/settings.yml"
}

# Public routes must answer, and both eve agents must report healthy. Runs
# inside the web container so it checks the app, not the tunnel.
smoke() {
  local sha="$1"
  compose "$sha" exec -T web node -e '
    const base = "http://127.0.0.1:3000";
    const checks = [
      ["/landing", (s) => s === 200],
      ["/polymath", (s) => s === 200 || (s >= 300 && s < 400)],
      ["/eve/polymath/v1/health", (s) => s === 200],
      ["/eve/specialist/v1/health", (s) => s === 200],
    ];
    (async () => {
      let ok = true;
      for (const [path, pass] of checks) {
        let status = 0;
        try { status = (await fetch(base + path, { redirect: "manual" })).status; } catch {}
        console.log(`  ${pass(status) ? "ok  " : "FAIL"} ${path} -> ${status}`);
        ok &&= pass(status);
      }
      process.exit(ok ? 0 : 1);
    })();
  '
}

start_release() {
  local sha="$1"
  compose "$sha" up -d --remove-orphans --wait --wait-timeout 420
}

# Nightly backup at 10:30 UTC (early morning in California), through the
# `current` symlink so it always runs the live release's script.
install_cron() {
  printf '%s\n' \
    'SHELL=/bin/bash' \
    "30 10 * * * root $home/current/deploy/oracle/server/backup.sh >> $home/backups/backup.log 2>&1" \
    | sudo tee /etc/cron.d/polymath-backup >/dev/null
  sudo chmod 644 /etc/cron.d/polymath-backup
  sudo install -d -m 700 "$home/backups"
}

prune() {
  local current previous
  current="$(read_release current-release)"
  previous="$(read_release previous-release)"
  # Newest first; keep the newest $keep_releases plus whatever is live.
  ls -1t "$home/releases" | tail -n +"$((keep_releases + 1))" | while read -r old; do
    [ "$old" = "$current" ] || [ "$old" = "$previous" ] && continue
    log "pruning release $old"
    sudo docker image rm "polymath-app:$old" >/dev/null 2>&1 || true
    sudo rm -rf "$home/releases/$old"
  done
  sudo docker image prune -f >/dev/null
}

deploy() {
  local sha="$1" previous
  [ -d "$home/releases/$sha" ] || { log "no release directory for $sha"; exit 1; }
  previous="$(read_release current-release)"

  render_searxng "$sha"

  log "building polymath-app:$sha"
  compose "$sha" build web

  if sudo docker ps --format '{{.Names}}' | grep -qx "${project}-db-1"; then
    log "pre-deploy backup"
    sudo "$home/releases/$sha/deploy/oracle/server/backup.sh" pre-deploy
  fi

  log "migrating"
  compose "$sha" up -d --wait db
  if ! compose "$sha" run --rm migrate; then
    log "migration failed; the running release (${previous:-none}) was not touched"
    exit 1
  fi

  log "starting $sha"
  if start_release "$sha" && smoke "$sha"; then
    if [ "$previous" != "$sha" ]; then
      [ -n "$previous" ] && echo "$previous" > "$home/previous-release"
      echo "$sha" > "$home/current-release"
    fi
    ln -sfn "$home/releases/$sha" "$home/current"
    install_cron
    prune
    log "deployed $sha"
    return 0
  fi

  log "release $sha failed its checks"
  compose "$sha" ps --all || true
  compose "$sha" logs --tail 60 web worker || true
  if [ -n "$previous" ] && [ "$previous" != "$sha" ]; then
    log "rolling back to $previous"
    start_release "$previous" && smoke "$previous" && log "rolled back to $previous"
  fi
  exit 1
}

rollback() {
  local current previous
  current="$(read_release current-release)"
  previous="$(read_release previous-release)"
  [ -n "$previous" ] || { log "no previous release recorded"; exit 1; }
  log "rolling back $current -> $previous (migrations stay applied)"
  start_release "$previous"
  smoke "$previous"
  echo "$current" > "$home/previous-release"
  echo "$previous" > "$home/current-release"
  ln -sfn "$home/releases/$previous" "$home/current"
  log "now serving $previous"
}

status() {
  local current
  current="$(read_release current-release)"
  echo "current:  ${current:-none}"
  echo "previous: $(read_release previous-release)"
  [ -n "$current" ] && compose "$current" ps --format 'table {{.Service}}\t{{.Status}}'
  sudo docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' | grep -E "^(NAME|${project}-)"
  df -h / | tail -1
}

case "${1:-}" in
  deploy) deploy "${2:?usage: release.sh deploy <sha>}" ;;
  rollback) rollback ;;
  status) status ;;
  *) echo "usage: release.sh deploy <sha> | rollback | status" >&2; exit 2 ;;
esac
