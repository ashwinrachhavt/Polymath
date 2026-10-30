import { allowLoopbackOnly, installFetchGuard } from "./helpers/fetch-guard";

/*
 * Loopback-only `globalThis.fetch` for the db project, installed before each
 * test file's module graph loads. The unit and ui projects run the strict
 * deny-all variant (tests/setup.fetch-guard.ts); this project cannot: its
 * integration tests drive real production code (the outbox dispatchers)
 * against local mock HTTP servers, exercising the real transport on purpose —
 * stubbing fetch there would prove the mock, not the code. External hosts
 * still fail closed here, the evals model host included.
 *
 * What this rejects: every fetch to a non-loopback host, before the
 * underlying transport is called. The evals guard (eve/polymath/evals/
 * network-guard.ts) stacks cleanly on top of this one and restores back to
 * it; see tests/helpers/fetch-guard.ts for why the two are separate modules.
 *
 * What no fetch guard can reject — a test boundary, not a sandbox:
 *   - raw HTTP via `node:http`/`node:https` or undici used directly
 *   - `net`/`tls` sockets and DNS lookups (PostgreSQL connections untouched:
 *     postgres.js speaks the wire protocol over sockets, never fetch)
 *   - child processes, and everything outside the Vitest worker: the Playwright
 *     e2e browser, the dev server it drives at localhost:3000, and the deployed
 *     app
 *
 * A test that needs an external HTTP exchange stubs it explicitly —
 * `vi.stubGlobal` replaces the guard for the stubbed scope, and restoring the
 * stub puts the guard back, so a restored mock can never leave native fetch
 * exposed.
 */
installFetchGuard({ policy: allowLoopbackOnly, label: "tests/setup.fetch-guard.loopback.ts" });
