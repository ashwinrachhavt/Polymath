#!/usr/bin/env bash
# Run Polymath agent evals locally and post the results to the branch's PR.
#
# Usage: scripts/run-evals-pr.sh [--no-comment] [evalId...]
#
# With eval ids given, each id runs serially (`eve eval <id> --json`); with
# none, every discovered eval runs in one invocation. A markdown results table
# is written to stdout. With an open PR for the current branch, the table is
# posted as a PR comment starting with <polymath-eval-results>, and any
# earlier comment carrying the same marker is deleted first (replace-not-
# stack). Exit 0 iff every eval passed after retries, 1 otherwise.
#
# Environment: before invoking eve, every credential-shaped variable (same
# predicate as the eval gate in eve/alfred/evals/stubs.ts — name ends with
# _KEY/_TOKEN/_SECRET, contains API_KEY, or starts with COMPOSIO_AUTH_CONFIG_)
# that is not on ALLOWED_EVAL_ENV is exported as empty, from both the
# inherited shell and the keys defined in eve/alfred/.env.local. eve's runner
# auto-loads .env.local into process.env, so clearing the parent shell is not
# enough; empty string counts as unset for the gate's isSet(). The allowlisted
# keys (GEMINI_API_KEY, GEMINI_AGENT_MODEL, OPENAI_API_KEY) are re-exported
# from .env.local when the shell does not already carry them — OPENAI_API_KEY
# may legitimately stay empty, the routed strong-model catalog entry just
# stays hidden. The gate is the authority; this sanitizer only keeps the
# common case quiet. No credential value is ever printed.
set -euo pipefail

RETRY_SLEEP="${RETRY_SLEEP:-60}" # seconds between 429 retries (tests use 0)
MAX_ATTEMPTS=3                   # 1 initial try + 2 retries

cd "$(dirname "$0")/../eve/alfred"

COMMENT_MARKER="<polymath-eval-results>"
ALLOWED=" GEMINI_API_KEY GEMINI_AGENT_MODEL OPENAI_API_KEY "
EVE_BIN="$PWD/node_modules/.bin/eve"

POST=true
if [ "${1:-}" = "--no-comment" ]; then
  POST=false
  shift
fi

[ -x "$EVE_BIN" ] || { echo "error: eve binary not found at $EVE_BIN" >&2; exit 2; }

# --- env sanitizer (mirrors assertEvalEnvironment's predicate) ---------------

cred_shaped() {
  case "$1" in
    *_KEY | *_TOKEN | *_SECRET | *API_KEY* | COMPOSIO_AUTH_CONFIG_*) return 0 ;;
    *) return 1 ;;
  esac
}

# Runner-injected harness credentials. The eval gate (stubs.ts) enumerates
# the exact credential-shaped names it exempts; the sanitizer is
# deliberately broader — wildcard prefixes clear CI-runner plumbing the
# enumerated gate never sees, and the gate remains the authority.
harness_injected() {
  case "$1" in
    ACTIONS_* | GITHUB_* | RUNNER_* | GH_TOKEN | GITHUB_TOKEN) return 0 ;;
    *) return 1 ;;
  esac
}

# Clear every credential-shaped name seen in the shell or defined in
# .env.local (eve injects the latter into process.env regardless of what the
# parent shell carries), except the allowlisted three and harness names.
while IFS= read -r name; do
  case "$name" in '' | *[!A-Za-z0-9_]*) continue ;; esac
  cred_shaped "$name" || continue
  harness_injected "$name" && continue
  case "$ALLOWED" in *" $name "*) continue ;; esac
  export "$name="
done < <( {
  env | sed 's/=.*//'
  sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env.local 2>/dev/null
} | sort -u )

# Re-export the allowlisted keys from .env.local when unset in the shell.
for a in $ALLOWED; do
  if [ -z "${!a:-}" ]; then
    val="$(sed -n "s/^${a}=//p" .env.local 2>/dev/null | head -n 1 || true)"
    if [ -n "$val" ]; then
      val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
      export "$a=$val"
    fi
  fi
done

# --- eval runs ---------------------------------------------------------------

IDS=()
if [ $# -gt 0 ]; then
  IDS=("$@")
fi

RAW="$(mktemp /tmp/eval-raw.XXXXXX)"
JSONF="$(mktemp /tmp/eval-json.XXXXXX)"
ENTF="$(mktemp /tmp/eval-entries.XXXXXX)"
BODY="$(mktemp /tmp/eval-pr-body.XXXXXX)"
trap 'rm -f "$RAW" "$JSONF" "$ENTF" "$BODY"' EXIT

OUT="" # global: last eve invocation's combined stdout+stderr

# Run eve once with the global id list; retries quota errors up to
# $MAX_ATTEMPTS attempts with a $RETRY_SLEEP-second backoff. Sets OUT to the
# final invocation's combined stdout+stderr (note: eve can exit nonzero and
# still print a complete JSON results document).
run_one() {
  local attempt=1
  while :; do
    if OUT="$("$EVE_BIN" eval ${IDS[@]+"${IDS[@]}"} --json 2>&1)"; then
      return 0
    fi
    # Quota errors: Gemini's per-minute window surfaces as "Too Many
    # Requests", gRPC quota as RESOURCE_EXHAUSTED.
    if grep -qiE 'too many requests|resource_exhausted|rate.?limit' <<<"$OUT" &&
      [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "429 on ${1:-<all>}, attempt $attempt — waiting ${RETRY_SLEEP}s (quota is not regression)" >&2
      sleep "$RETRY_SLEEP"
      attempt=$((attempt + 1))
      continue
    fi
    return 1
  done
}

# eve eval --json prints human log lines on stdout and stderr around the JSON
# document; the document starts at the first line beginning with "{" and ends
# at the last line beginning with "}" at or after it (both shapes observed:
# pretty-printed multi-line and single-line, with log noise before and after).
# Print it, or return 1 when the run produced no JSON.
json_part() { # $1 = file with the raw output
  local start end
  start="$(awk '/^\{/ {print NR; exit}' "$1")"
  [ -n "$start" ] || return 1
  # Single-line document: the start line is itself complete JSON.
  if sed -n "${start}p" "$1" | jq -e type >/dev/null 2>&1; then
    sed -n "${start}p" "$1"
    return 0
  fi
  end="$(awk -v s="$start" 'NR >= s && /^\}/ { line = NR } END { print line }' "$1")"
  [ -n "$end" ] || return 1
  sed -n "${start},${end}p" "$1" | jq -e type >/dev/null 2>&1 || return 1
  sed -n "${start},${end}p" "$1"
}

failed_labels() { # $1 = entries json file (array of result objects)
  jq -r 'if type == "array" then . else [.] end
    | [ .[] | select(.verdict != "passed")
        | ((.assertions // [])[] | select(.passed != true) | .name) ]
    | join("; ")' "$1"
}

record() { # $1 = row id, $2 = entries json file ("" when no JSON), $3 = raw file
  local id="$1" ent="${2:-}" raw="$3" label=""
  if [ -n "$ent" ] &&
    jq -e 'length > 0 and ([.[] | select(.verdict == "passed")] | length) == length' "$ent" >/dev/null 2>&1; then
    ROWS+=("| \`$id\` | ✅ pass | |")
    return 0
  fi
  FAILED+=("$id")
  if [ -n "$ent" ]; then
    label="$(failed_labels "$ent" 2>/dev/null || true)"
  fi
  if [ -z "$label" ]; then
    label="$(grep -m1 -oE 'EvalEnvironmentViolation: [A-Za-z0-9_]+ is set' "$raw" 2>/dev/null || true)"
  fi
  [ -n "$label" ] || label="no JSON result — see log"
  label="${label//|/\\|}"  # keep the table intact
  label="${label:0:300}"
  ROWS+=("| \`$id\` | ❌ fail | $label |")
  printf '%s\n' "$(cat "$raw")" > "/tmp/eval-${id//\//-}.log"
}

declare -a ROWS=()
declare -a FAILED=()

if [ "${#IDS[@]}" -gt 0 ]; then
  for id in "${IDS[@]}"; do
    # A nonzero eve exit can still carry full JSON results (failing
    # assertions), so JSON extraction is attempted either way.
    run_one "$id" || true
    printf '%s\n' "$OUT" > "$RAW"
    if json_part "$RAW" > "$JSONF" && jq -e . "$JSONF" >/dev/null 2>&1; then
      jq '.results' "$JSONF" > "$ENTF"
      record "$id" "$ENTF" "$RAW"
    else
      record "$id" "" "$RAW"
    fi
  done
else
  # No ids given: one invocation runs every discovered eval; each entry in
  # the results array gets its own row. Nonzero exits still carry JSON.
  run_one "<all>" || true
  printf '%s\n' "$OUT" > "$RAW"
  if json_part "$RAW" > "$JSONF" && jq -e . "$JSONF" >/dev/null 2>&1; then
    n="$(jq '.results | length' "$JSONF")"
    i=0
    while [ "$i" -lt "$n" ]; do
      jq "[.results[$i]]" "$JSONF" > "$ENTF"
      record "$(jq -r ".results[$i].id" "$JSONF")" "$ENTF" "$RAW"
      i=$((i + 1))
    done
  else
    record "<all>" "" "$RAW"
  fi
fi

# --- report ------------------------------------------------------------------

{
  echo "$COMMENT_MARKER"
  echo ""
  echo "## Polymath eval results"
  echo ""
  echo "| eval | result | failed assertions |"
  echo "| --- | --- | --- |"
  if [ "${#ROWS[@]}" -gt 0 ]; then
    printf '%s\n' ${ROWS[@]+"${ROWS[@]}"}
  else
    echo "| (no evals ran) | — | |"
  fi
  echo ""
  echo "_Ran $(date -u '+%Y-%m-%dT%H:%MZ'); serial; 429s retried (max $MAX_ATTEMPTS attempts, ${RETRY_SLEEP}s backoff)._"
} > "$BODY"

if $POST; then
  pr="$(gh pr view --json number -q .number 2>/dev/null || true)"
  if [ -n "$pr" ]; then
    # Replace-not-stack, post-first: a failed post must leave the previous
    # results in place, so the new comment lands before any deletion.
    new_url="$(gh pr comment "$pr" --body-file "$BODY" 2>/dev/null)" || new_url=""
    if [ -n "$new_url" ]; then
      # The new comment's own URL ends in its id; exclude it from the stale
      # sweep, or the deletion loop removes what we just posted.
      new_id="${new_url##*-}"
      # Collect stale marker comments across all pages (issues API is
      # oldest-first; a marker beyond page 1 must still be replaced).
      page=1
      while :; do
        batch="$(gh api "repos/{owner}/{repo}/issues/$pr/comments?per_page=100&page=$page" \
          --jq ".[] | select(.body | startswith(\"$COMMENT_MARKER\")) | select(.id != $new_id) | .id" 2>/dev/null || true)"
        while IFS= read -r cid; do
          [ -n "$cid" ] || continue
          gh api -X DELETE "repos/{owner}/{repo}/issues/comments/$cid" >/dev/null || true
        done <<<"$batch"
        [ ${#batch} -gt 0 ] || break
        page=$((page + 1))
      done
      echo "Posted eval results to PR #$pr"
    else
      echo "warning: posting the results comment failed; previous comment left intact" >&2
    fi
  else
    echo "No open PR for this branch; eval results comment body:"
    cat "$BODY"
  fi
else
  cat "$BODY"
fi

if [ "${#FAILED[@]}" -gt 0 ]; then
  echo "Failed evals: ${FAILED[*]}" >&2
  exit 1
fi
