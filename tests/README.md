# tests/

Organised by what a test proves, not by which file it covers.
`unit/`, `integration/`, `contract/`, `migration/` and `e2e/` all exist;
the table below says what each holds.

| Folder | Holds | Runs on |
|---|---|---|
| `unit/` | State machines, policy, ranking, scheduling, mappings, redaction, risk classification | Vitest |
| `integration/` | Idempotency, version conflicts, audit atomicity, tenancy, vector and full-text search | Vitest, against real Postgres |
| `contract/` | Sanitized Composio/Firecrawl fixtures, companion schemas, stable problem responses | Vitest |
| `migration/` | Golden donor fixtures, counts, checksums, referential checks, rerun idempotency | Vitest, against real Postgres |
| `e2e/` | Journeys, not pages | Playwright |

Provider contract tests use sanitized fixtures — never live calls in CI, and
never real contacts, mail, resumes, tokens, or screenshots of private data.

## The fetch boundary

Every Vitest project installs a guard on `globalThis.fetch` before test
modules load, so an accidental `fetch(...)` fails with `TestNetworkViolation`
instead of reaching the network — rejection happens before any transport, and
even the evals model host is denied. The `unit` and `ui` projects run
**deny-all** (`tests/setup.fetch-guard.ts`, loopback included); the `db`
project runs **loopback-only** (`tests/setup.fetch-guard.loopback.ts`) so its
integration tests can drive real production code against local mock HTTP
servers — every external host still fails closed there.

No fetch guard can see past the fetch API: `node:http`/`node:https`, undici
used directly, `net`/`tls` sockets, DNS, child processes, the Postgres
connection (which speaks sockets, not fetch), the Playwright browser, and the
dev server it drives are all outside it — it is a test boundary, not a
sandbox. A test that needs an HTTP exchange stubs it explicitly
(`vi.stubGlobal("fetch", …)` or a fixture transport); restoring the stub puts
the guard back, so a restored mock can never leave native fetch exposed.

Two rules that decide most cases: invariants run against **real Postgres**
(mocks prove the mock works), and Playwright covers journeys
(capture → task → briefing → focus → completion), not markup.

`tests/unit`, `tests/integration`, `tests/contract`, and `tests/migration` are
already wired into `vitest.config.mts`; create the folder and drop a test in.
