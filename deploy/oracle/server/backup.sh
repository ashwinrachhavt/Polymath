#!/usr/bin/env bash
# Runs on the VM as root: nightly from /etc/cron.d/polymath-backup, and from
# release.sh before every migration.
#
#   backup.sh [label]   pg_dump -Fc of the app database into
#                       /opt/polymath/backups/axiom-<utc stamp>[-label].dump,
#                       and the uploaded files (blobs volume) into
#                       blobs-<utc stamp>[-label].tar.gz
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
echo "[$(date -u +%FT%TZ)] backup ok: $out ($(du -h "$out" | cut -f1))"

# Uploaded originals (the blobs volume). A dump without them would restore
# documents whose files are gone. Checked by listing the archive back.
blobs="$(docker volume inspect -f '{{.Mountpoint}}' polymath_blobs 2>/dev/null || true)"
if [ -n "$blobs" ] && [ -d "$blobs" ]; then
  files="$dir/blobs-${stamp}${1:+-$1}.tar.gz"
  tar -czf "$files.partial" -C "$blobs" .
  tar -tzf "$files.partial" > /dev/null
  mv "$files.partial" "$files"
  echo "[$(date -u +%FT%TZ)] files ok: $files ($(du -h "$files" | cut -f1), $(find "$blobs" -type f | wc -l) files)"
fi

find "$dir" -maxdepth 1 \( -name 'axiom-*.dump' -o -name 'blobs-*.tar.gz' \) -mtime +6 -delete
find "$dir" -maxdepth 1 -name '*.partial' -mmin +60 -delete
