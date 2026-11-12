#!/usr/bin/env bash
# Copies the server's newest database backup to the laptop, the off-box copy.
#   deploy/oracle/pull-backup.sh [dest]   default ~/Backups/polymath/oracle
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

dest="${1:-$HOME/Backups/polymath/oracle}"
mkdir -p "$dest"
latest="$(oracle_ssh "sudo ls -1t $ORACLE_HOME_DIR/backups/ | grep '^axiom-.*\.dump$' | head -1")"
[ -n "$latest" ] || { echo "no backups on the server yet" >&2; exit 1; }
umask 077
oracle_ssh "sudo cat $ORACLE_HOME_DIR/backups/$latest" > "$dest/$latest.partial"
mv "$dest/$latest.partial" "$dest/$latest"
echo "copied $latest to $dest ($(du -h "$dest/$latest" | cut -f1))"
