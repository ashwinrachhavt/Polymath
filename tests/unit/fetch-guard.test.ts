import { describe, expect, it, vi } from "vitest";
import { allowLoopbackOnly, denyAll, guardedFetch, installFetchGuard, TestNetworkViolation } from "../helpers/fetch-guard";

/*
 * The fetch boundary, proven to fail closed. The setup file
 * (tests/setup.fetch-guard.ts) has already installed the deny-all guard on
 * `globalThis.fetch` before this module loads, so the global tests below run
 * against the real installed guard — the same discipline the evals guard's
 * tests use (tests/unit/eval-guards.test.ts), which stack on top of this one.
 *
 * External hosts here use the reserved `.test` TLD where a guard regression
 * could otherwise leak a real request; the one real hostname (the evals model
 * host) pins that its allowlist was not inherited.
 */

describe("guardedFetch", () => {
  it("rejects an external fetch before the underlying transport is called", async () => {
    const transport = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    const guarded = guardedFetch(transport, denyAll, "negative-test");

    await expect(guarded("https://api.composio.dev/v1/x")).rejects.toThrow(TestNetworkViolation);
    expect(transport).not.toHaveBeenCalled();
  });

  it("names the host and the guard that denied it", async () => {
    const transport = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    const guarded = guardedFetch(transport, denyAll, "negative-test");

    await expect(guarded("https://api.composio.dev/v1/x")).rejects.toThrow(
      "TestNetworkViolation: api.composio.dev (negative-test)",
    );
  });

  it("under the loopback-only policy, rejects external before transport and passes loopback through", async () => {
    const transport = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
    const guarded = guardedFetch(transport, allowLoopbackOnly, "negative-test");

    await expect(guarded("https://api.composio.dev/v1/x")).rejects.toThrow(TestNetworkViolation);
    expect(transport).not.toHaveBeenCalled();

    await guarded("http://127.0.0.1:37747/firecrawl");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("the installed guard (tests/setup.fetch-guard.ts)", () => {
  it("denies an external fetch on globalThis.fetch", async () => {
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });

  it("denies the evals model host — the allowlist was not inherited", async () => {
    await expect(
      globalThis.fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"),
    ).rejects.toThrow(TestNetworkViolation);
  });

  it("denies plain http and loopback targets", async () => {
    await expect(globalThis.fetch("http://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
    // Loopback is denied too under this project's deny-all policy: Postgres is
    // reached over sockets, not fetch, and the dev server belongs to the
    // Playwright suite, not Vitest. (The db project runs the loopback-only
    // policy instead — its integration tests exercise real transports.)
    await expect(globalThis.fetch("http://127.0.0.1:5432/")).rejects.toThrow(TestNetworkViolation);
    await expect(globalThis.fetch("http://localhost:3000/api/v1/x")).rejects.toThrow(TestNetworkViolation);
  });

  it("fails closed on URL objects, Request inputs, and unparseable URLs", async () => {
    await expect(globalThis.fetch(new URL("https://payments.evil.test/v1/x"))).rejects.toThrow(
      TestNetworkViolation,
    );
    await expect(globalThis.fetch(new Request("https://payments.evil.test/v1/x"))).rejects.toThrow(
      TestNetworkViolation,
    );
    // A relative URL is meaningless in a test worker; it must deny, not crash.
    await expect(globalThis.fetch("/api/v1/x")).rejects.toThrow(TestNetworkViolation);
  });
});

describe("explicit doubles compose with the guard", () => {
  it("lets a stubbed double serve, and restoring it re-arms the guard", async () => {
    const double = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", double);
    try {
      const response = await globalThis.fetch("https://api.composio.dev/v1/needed-by-this-test");
      expect(await response.text()).toBe('{"ok":true}');
      expect(double).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
    // The stub's save/restore put the guard back — native fetch is not exposed.
    await expect(globalThis.fetch("https://api.composio.dev/v1/x")).rejects.toThrow(TestNetworkViolation);
  });

  it("returns the live uninstaller instead of stacking a second guard", () => {
    // The setup guard is active; both installs must hand back the same
    // uninstaller rather than wrapping the wrapper.
    expect(installFetchGuard()).toBe(installFetchGuard());
  });

  it("re-arms on the next install after its uninstaller runs", async () => {
    const restore = installFetchGuard();
    restore();
    installFetchGuard(); // fresh wrap over whatever is beneath — the worker stays guarded
    await expect(globalThis.fetch("https://payments.evil.test/v1/x")).rejects.toThrow(TestNetworkViolation);
  });
});
