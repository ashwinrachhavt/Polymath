import { installFetchGuard } from "./helpers/fetch-guard";

/*
 * Default-deny `globalThis.fetch`, installed before each test file's module
 * graph loads — including every `src/` module the tests import, so even
 * module-init-time fetches are caught. Wired into the unit and ui projects
 * via `setupFiles` in vitest.config.mts. The db project installs the
 * loopback-only variant (tests/setup.fetch-guard.loopback.ts) because its
 * integration tests exercise real production code against local mock HTTP
 * servers; every non-loopback host fails closed there.
 *
 * What this rejects: every `fetch(...)` the test process attempts, any host,
 * loopback included. The existing eval guard (eve/polymath/evals/
 * network-guard.ts) stacks cleanly on top of this one and restores back to it;
 * see tests/helpers/fetch-guard.ts for why the two are separate modules.
 *
 * What this does NOT reject — a test boundary, not a sandbox:
 *   - raw HTTP via `node:http`/`node:https` or undici used directly
 *   - `net`/`tls` sockets and DNS lookups (PostgreSQL connections untouched:
 *     postgres.js speaks the wire protocol over sockets, never fetch)
 *   - child processes, and everything outside the Vitest worker: the Playwright
 *     e2e browser, the dev server it drives at localhost:3000, and the deployed
 *     app
 *
 * A test that needs an HTTP exchange stubs it explicitly — `vi.stubGlobal`
 * replaces the guard for the stubbed scope, and restoring the stub puts the
 * guard back, so a restored mock can never leave native fetch exposed.
 */
installFetchGuard();
