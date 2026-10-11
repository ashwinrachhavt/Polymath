# tests/

Organised by what a test proves, not by which file it covers
(agents/engineering.md). Only `e2e/` exists so far — the rest fill in as the
code they test arrives, rather than sitting here empty.

| Folder | Holds | Runs on |
|---|---|---|
| `unit/` | State machines, policy, ranking, scheduling, mappings, redaction, risk classification | Vitest |
| `integration/` | Idempotency, version conflicts, audit atomicity, tenancy, vector and full-text search | Vitest, against real Postgres |
| `contract/` | Sanitized Composio/Firecrawl fixtures, companion schemas, stable problem responses | Vitest |
| `migration/` | Golden donor fixtures, counts, checksums, referential checks, rerun idempotency | Vitest, against real Postgres |
| `e2e/` | Journeys, not pages | Playwright |

Provider contract tests use sanitized fixtures — never live calls in CI, and
never real contacts, mail, resumes, tokens, or screenshots of private data.

Two rules that decide most cases: invariants run against **real Postgres**
(mocks prove the mock works), and Playwright covers journeys
(capture → task → briefing → focus → completion), not markup.

`tests/unit`, `tests/integration`, `tests/contract`, and `tests/migration` are
already wired into `vitest.config.mts`; create the folder and drop a test in.
