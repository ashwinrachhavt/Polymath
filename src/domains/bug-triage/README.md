# bug-triage

The bug agent: errors and bug reports become deduplicated, scrubbed GitHub issues, and small high-confidence ones get a draft fix PR from Claude Code. A human always merges.

## Flow

```
Sentry alert ──► POST /api/webhooks/sentry ─┐
"Report a bug" ─► reportBugAction ──────────┼─► bug_signals (one row per fingerprint)
                                            │        │ outbox worker, once a minute, ≤ cap/day
                                            │        ▼
                                            │   triage ──► GitHub issue (labels, files, related)
                                            │                  │ `agent:fix` (triage or by hand)
CI red on main ──► bug-agent-ci-red.yml ────┘                  ▼
                   (one open issue per workflow)    bug-agent-fix.yml ──► draft PR on bugfix/issue-N
```

| File        | Role                                                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scrub.ts`  | Removes emails, tokens, IPs, ids, URLs, query params and long quoted text. Everything published passes through it.      |
| `signal.ts` | Parses Sentry events and in-app reports into one scrubbed `BugSignal` shape, and gives each its fingerprint.            |
| `triage.ts` | Pure rules: area, severity, reproducibility, suspected files, the `agent:fix` decision, and the issue text.             |
| `store.ts`  | Dedupe (unique fingerprint, counted sightings) and the daily cap (advisory-locked claim that counts filed + in-flight). |
| `pass.ts`   | One filing pass for the worker; `bugAgentConfig` is the kill switch.                                                    |
| `github.ts` | Search and create issues over the REST API.                                                                             |

## Rules that hold

- Issues are built from an allowlist of fields, never a raw payload, and every field is scrubbed. The repository is public.
- One fingerprint is one issue: Sentry issue id for alerts; route pattern + error id for reports. A crash between creating the issue and storing its number is recovered by searching for the fingerprint first.
- At most `BUG_AGENT_MAX_ISSUES_PER_DAY` (default 5) issues per UTC day; the rest wait, most-seen first. Fix PRs are capped separately in the workflow (`BUG_AGENT_MAX_PRS_PER_DAY`, default 2).
- `agent:fix` only for a Sentry error of a simple type (TypeError, ReferenceError, RangeError) whose in-app trace avoids migrations, auth, identity and the proxy. The fix workflow re-checks the real diff: no workflows, migrations, auth, deploy, env or dependency files; at most 8 files and 300 lines; a unit test that passes.
- Nothing merges automatically. The agent never reads secrets beyond its own token and never deploys.
- Kill switches: `BUG_AGENT_ENABLED=true` in the app env (worker) and the repository variable `BUG_AGENT_ENABLED=true` (both workflows).
