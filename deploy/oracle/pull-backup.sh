#!/usr/bin/env bash
# Copies the server's newest database dump and uploaded-files archive to the
# laptop: the off-box copy.
#   deploy/oracle/pull-backup.sh [dest]   default ~/Backups/polymath/oracle
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

dest="${1:-$HOME/Backups/polymath/oracle}"
mkdir -p "$dest"
umask 077
# The newest database dump and the newest uploaded-files archive.
for pattern in '^axiom-.*\.dump$' '^blobs-.*\.tar\.gz$'; do
  latest="$(oracle_ssh "sudo ls -1t $ORACLE_HOME_DIR/backups/ | grep '$pattern' | head -1")"
  [ -n "$latest" ] || { echo "no backup matching $pattern on the server" >&2; continue; }
  oracle_ssh "sudo cat $ORACLE_HOME_DIR/backups/$latest" > "$dest/$latest.partial"
  mv "$dest/$latest.partial" "$dest/$latest"
  echo "copied $latest to $dest ($(du -h "$dest/$latest" | cut -f1))"
done
