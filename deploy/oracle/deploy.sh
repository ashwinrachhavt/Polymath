#!/usr/bin/env bash
# Deploys a commit of this repo to the Oracle VM. Run from the laptop.
#
#   deploy/oracle/deploy.sh [ref]     default origin/main
#   deploy/oracle/deploy.sh --rollback
#   deploy/oracle/deploy.sh --status
#
# The server never talks to GitHub: the commit travels as a `git archive` over
# SSH, so the VM holds no repository credentials. On the server,
# server/release.sh builds the image, backs up the database, migrates, swaps
# containers, health-checks, and puts the previous release back on failure.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
. "$here/lib.sh"

release_sh() { oracle_ssh "bash $ORACLE_HOME_DIR/releases/$1/deploy/oracle/server/release.sh ${*:2}"; }
current_release() { oracle_ssh "cat $ORACLE_HOME_DIR/current-release 2>/dev/null || true"; }

case "${1:-}" in
  --rollback)
    sha="$(current_release)"
    [ -n "$sha" ] || { echo "nothing deployed yet" >&2; exit 1; }
    release_sh "$sha" rollback
    exit 0
    ;;
  --status)
    sha="$(current_release)"
    [ -n "$sha" ] || { echo "nothing deployed yet" >&2; exit 1; }
    release_sh "$sha" status
    exit 0
    ;;
esac

ref="${1:-origin/main}"
git -C "$here" fetch --quiet origin
sha="$(git -C "$here" rev-parse --verify "${ref}^{commit}")"
echo "deploying $ref ($sha) to $ORACLE_HOST"

# From the repository root: run inside deploy/oracle, git archive would pack
# only that folder.
root="$(git -C "$here" rev-parse --show-toplevel)"
rel="$ORACLE_HOME_DIR/releases/$sha"
if oracle_ssh "test -f $rel/package.json"; then
  echo "release $sha already on the server"
else
  oracle_ssh "rm -rf $rel $rel.tmp && mkdir -p $rel.tmp"
  git -C "$root" archive --format=tar "$sha" \
    | oracle_ssh "tar -x -C $rel.tmp && mv $rel.tmp $rel"
fi

release_sh "$sha" deploy "$sha"
