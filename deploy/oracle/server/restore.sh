#!/usr/bin/env bash
# Runs on the VM as root.
#
#   restore.sh <dump> <database>   restore a pg_dump -Fc archive into a
#                                  database that is missing or has no tables
#   restore.sh --verify [dump]     restore a dump (default: the newest backup)
#                                  into a scratch database, compare its row
#                                  counts with the live database, drop it
#
# Restoring over the live `axiom` database is deliberately not a one-liner:
# stop web and worker, drop and recreate it, then run `restore.sh <dump> axiom`.
# The README has the full sequence.
set -euo pipefail

container=polymath-db-1
psql_as() { docker exec -i "$container" psql -U axiom -v ON_ERROR_STOP=1 -At "$@"; }

table_count() {
  psql_as -d "$1" -c "select count(*) from information_schema.tables where table_schema = 'public'"
}

restore_into() {
  local dump="$1" db="$2"
  [ -f "$dump" ] || { echo "no such dump: $dump" >&2; exit 1; }
  if [ "$(psql_as -d postgres -c "select 1 from pg_database where datname = '$db'")" = "1" ]; then
    if [ "$(table_count "$db")" != "0" ]; then
      echo "refusing: database $db already has tables" >&2
      exit 1
    fi
  else
    psql_as -d postgres -c "create database \"$db\"" >/dev/null
  fi
  # --no-owner/--no-acl: the archive may come from another cluster's roles.
  docker exec -i "$container" pg_restore -U axiom -d "$db" --no-owner --no-acl --exit-on-error < "$dump"
  echo "restored $(basename "$dump") into $db: $(table_count "$db") tables"
}

# Exact row counts for every public table, as "table count" lines.
row_counts() {
  psql_as -d "$1" <<'SQL'
select format('select %L || '' '' || count(*) from public.%I;', table_name, table_name)
from information_schema.tables
where table_schema = 'public' and table_type = 'BASE TABLE'
order by table_name
\gexec
SQL
}

verify() {
  local dump="${1:-$(ls -1t /opt/polymath/backups/axiom-*.dump | head -1)}"
  local scratch="axiom_restore_check"
  psql_as -d postgres -c "drop database if exists $scratch" >/dev/null
  restore_into "$dump" "$scratch"
  local live restored
  live="$(row_counts axiom)"
  restored="$(row_counts "$scratch")"
  psql_as -d postgres -c "drop database $scratch" >/dev/null
  echo "tables: live $(echo "$live" | wc -l), restored $(echo "$restored" | wc -l)"
  echo "rows:   live $(echo "$live" | awk '{s+=$2} END {print s}'), restored $(echo "$restored" | awk '{s+=$2} END {print s}')"
  # Writes since the dump can make the live side larger; anything else differing is a problem.
  diff <(echo "$live") <(echo "$restored") | sed 's/^/  /' || true
}

case "${1:-}" in
  --verify) verify "${2:-}" ;;
  "" | -h | --help) sed -n '2,13p' "$0" ;;
  *) restore_into "$1" "${2:?usage: restore.sh <dump> <database>}" ;;
esac
