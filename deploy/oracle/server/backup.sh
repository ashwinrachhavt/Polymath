#!/usr/bin/env bash
# Runs on the VM as root: nightly from /etc/cron.d/polymath-backup, and from
# release.sh before every migration.
#
#   backup.sh [label]   pg_dump -Fc of the app database into
#                       /opt/polymath/backups/axiom-<utc stamp>[-label].dump
#
# A dump only counts once pg_restore can read its table of contents. Dumps
# older than 7 days are deleted. Off-box copies: deploy/oracle/pull-backup.sh
# copies the newest one to the laptop.
set -euo pipefail
umask 077

dir=/opt/polymath/backups
container=polymath-db-1
mkdir -p "$dir"
chmod 700 "$dir"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$dir/axiom-${stamp}${1:+-$1}.dump"

docker exec "$container" pg_dump -U axiom -d axiom -Fc > "$out.partial"
docker exec -i "$container" pg_restore -l < "$out.partial" > /dev/null
mv "$out.partial" "$out"

find "$dir" -maxdepth 1 -name 'axiom-*.dump' -mtime +6 -delete
find "$dir" -maxdepth 1 -name 'axiom-*.partial' -mmin +60 -delete

echo "[$(date -u +%FT%TZ)] backup ok: $out ($(du -h "$out" | cut -f1))"
