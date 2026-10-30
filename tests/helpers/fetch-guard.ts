/*
 * Default-deny `globalThis.fetch` for every Vitest project, installed by
 * `tests/setup.fetch-guard.ts` before any test module loads.
 *
 * Why a guard at all: the test suite's no-network property was a convention,
 * not a gate — nothing stopped a one-line `fetch(...)` regression from shipping
 * as "works locally". This converts it into a loud, immediate failure.
 *
 * Why deny ALL, loopback included: a fetch tripwire over the entire unit
 * project recorded zero calls — not even loopback — and a static sweep finds
 * no fetch/axios/undici in tests/integration either (research S2, 2026-10-30).
 * Vitest tests reach Postgres over sockets (postgres.js), not fetch, and the
 * e2e suite's `localhost:3000` traffic belongs to Playwright, which this does
 * not touch. A test that genuinely needs an HTTP exchange stubs it explicitly:
 * `vi.stubGlobal("fetch", …)` replaces the guard for the stubbed scope and
 * restoring it puts the guard back.
 *
 * Why not reuse `eve/polymath/evals/network-guard.ts` as the module: two
 * reasons, both checked against its source. Its policy allows the evals model
 * host (`generativelanguage.googleapis.com`) — exactly the access tests must
 * not have. And its lifecycle is a module-level single-active-guard slot; a
 * setup-file install would occupy that slot for the whole worker process, so
 * `tests/unit/eval-guards.test.ts` installs of the eval guard would silently
 * no-op and their model-host pass-through cases would fail. This module
 * mirrors the evals guard's proven lifecycle instead (single active install,
 * restore returns exactly what was beneath, fail-closed on unparseable URLs)
 * with its own state and its own deny-all policy.
 *
 * Scope, stated plainly because it matters: this guards in-process
 * `globalThis.fetch` in the test worker only. It does NOT block raw HTTP via
 * `node:http`/`node:https`, undici imported directly, `net`/`tls` sockets,
 * DNS lookups, child processes, PostgreSQL connections, the dev server and
 * browser of the Playwright e2e suite, or any outbound traffic from a running
 * app outside Vitest. It is a test boundary, not a sandbox.
 */

export class TestNetworkViolation extends Error {
  readonly host: string;
  readonly label: string;

  constructor(host: string, label: string) {
    super(
      `TestNetworkViolation: ${host} (${label}) — global fetch is denied in ` +
        `Vitest tests. If this call is intentional, stub it in the test ` +
        `with vi.stubGlobal("fetch", …) or use a fixture transport; see ` +
        `tests/helpers/fetch-guard.ts.`,
    );
    this.name = "TestNetworkViolation";
    this.host = host;
    this.label = label;
  }
}

type Fetcher = typeof globalThis.fetch;

/**
 * The guard's policy: given the parsed URL (undefined when unparseable) and
 * the raw input, decide whether the request may reach the transport. The
 * deny-all decision is one auditable line; a future loopback-only policy is a
 * new function here rather than edits in every call site.
 */
export type FetchPolicy = (url: URL | undefined, raw: string) => boolean;

/** The strictest policy: permit nothing, loopback included. */
export function denyAll(): boolean {
  return false;
}

/**
 * Permit only loopback origins. Used by the db project, whose integration
 * tests drive real production code (the outbox dispatchers) against local
 * mock HTTP servers — real transport, deliberately; stubbing fetch there
 * would prove the mock, not the code. External hosts still fail closed, the
 * model host included.
 */
export function allowLoopbackOnly(url: URL | undefined): boolean {
  return url !== undefined && isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  // URL normalizes `[::1]` to `[::1]`; the brackets are part of `hostname`.
  return hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]" || hostname === "localhost";
}

function requestUrl(input: Parameters<Fetcher>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  // A Request's `url` is the absolute URL the fetch would use.
  return (input as Request).url;
}

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    // An unparseable URL (relative URLs, garbage) grants nothing.
    return undefined;
  }
}

/**
 * Wrap `base` so every request is first checked against `policy`; a denial
 * throws `TestNetworkViolation` BEFORE `base` — the underlying transport —
 * is ever called. `base` stays a parameter (rather than the guard capturing
 * nothing) so a test can pass a recording spy and pin that rejection happens
 * without any transport involvement.
 */
export function guardedFetch(base: Fetcher, policy: FetchPolicy, label: string): Fetcher {
  return async (input, init) => {
    const raw = requestUrl(input);
    const url = parse(raw);
    if (!policy(url, raw)) throw new TestNetworkViolation(url?.host ?? raw, label);
    return await base(input, init);
  };
}

interface ActiveGuard {
  readonly restore: () => void;
}

// One guard per process. Re-installing returns the live uninstaller instead of
// stacking wrappers, so a double install cannot multiply the wrapping. This
// state is module-local: the evals guard keeps its own, so the two guards can
// stack (eval guard wrapping this one) without occupying each other's slot.
let active: ActiveGuard | undefined;

/**
 * Install the deny-all guard on `globalThis.fetch` and return its
 * uninstaller. The setup files call this once per test file and discard the
 * uninstaller — the baseline is not meant to be removed mid-run; tests layer
 * explicit doubles on top with `vi.stubGlobal` instead. The policy defaults
 * to `denyAll`; the db project's setup passes `allowLoopbackOnly` (see that
 * file for why it must differ).
 */
export function installFetchGuard(
  options: { policy?: FetchPolicy; label?: string } = {},
): () => void {
  if (active !== undefined) return active.restore;

  const base = globalThis.fetch;
  const label = options.label ?? "tests/setup.fetch-guard.ts";
  const policy = options.policy ?? denyAll;
  const restore = () => {
    globalThis.fetch = base;
    active = undefined;
  };

  active = { restore };
  globalThis.fetch = guardedFetch(base, policy, label);
  return restore;
}
