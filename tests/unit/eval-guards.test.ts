import { afterEach, describe, expect, it } from "vitest";
import {
  EvalNetworkViolation,
  installNetworkGuard,
} from "../../eve/alfred/evals/network-guard";
import {
  assertEvalEnvironment,
  EvalEnvironmentViolation,
  quietStubs,
  STUBBED_TOOLS,
} from "../../eve/alfred/evals/stubs";

/*
 * The two runtime guards, proven to fail closed. The static guard (coverage of
 * the stub list) is eval-stub-coverage.test.ts; these are the halves that only
 * bite while an eval is running, so they are exercised here against the real
 * `globalThis.fetch` rather than a mock.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("assertEvalEnvironment", () => {
  it("passes with only the model key", () => {
    expect(() => assertEvalEnvironment({ GEMINI_API_KEY: "model-key" })).not.toThrow();
  });

  it("throws naming a provider key", () => {
    expect(() => assertEvalEnvironment({ COMPOSIO_API_KEY: "x" })).toThrow(EvalEnvironmentViolation);
    expect(() => assertEvalEnvironment({ COMPOSIO_API_KEY: "x" })).toThrow(/COMPOSIO_API_KEY/);
  });

  it("treats a Composio auth config id as provider access", () => {
    expect(() => assertEvalEnvironment({ COMPOSIO_AUTH_CONFIG_GMAIL: "ac_1" })).toThrow(
      /COMPOSIO_AUTH_CONFIG_GMAIL/,
    );
  });

  it("ignores a blank value, which grants nothing", () => {
    expect(() => assertEvalEnvironment({ FIRECRAWL_HOSTED_API_KEY: "   " })).not.toThrow();
  });
});

describe("installNetworkGuard", () => {
  it("blocks a provider host and names it", async () => {
    const restore = installNetworkGuard({ label: "chat-grounding/groundedAnswer" });
    try {
      await expect(globalThis.fetch("https://api.composio.dev/v1/x")).rejects.toThrow(EvalNetworkViolation);
      await expect(globalThis.fetch("https://api.composio.dev/v1/x")).rejects.toThrow(
        "EvalNetworkViolation: api.composio.dev (tool: chat-grounding/groundedAnswer)",
      );
    } finally {
      restore();
    }
  });

  it("blocks a host that merely resembles the model endpoint", async () => {
    const restore = installNetworkGuard();
    try {
      await expect(globalThis.fetch("https://generativelanguage.googleapis.com.evil.test/v1")).rejects.toThrow(
        EvalNetworkViolation,
      );
    } finally {
      restore();
    }
  });

  it("passes the model host through to the transport underneath", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const restore = installNetworkGuard();
    try {
      await globalThis.fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      expect(seen).toEqual(["https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"]);
    } finally {
      restore();
    }
  });

  it("allows only a loopback control plane, exact origin", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const restore = installNetworkGuard({ controlPlaneOrigin: "http://127.0.0.1:43123" });
    try {
      await globalThis.fetch("http://127.0.0.1:43123/eve/v1/sessions");
      // A different loopback port is a different service and still fails closed.
      await expect(globalThis.fetch("http://127.0.0.1:5432/")).rejects.toThrow(EvalNetworkViolation);
      expect(seen).toEqual(["http://127.0.0.1:43123/eve/v1/sessions"]);
    } finally {
      restore();
    }
  });

  it("ignores a non-loopback control plane rather than widening the guard", async () => {
    const restore = installNetworkGuard({ controlPlaneOrigin: "https://polymath.example" });
    try {
      await expect(globalThis.fetch("https://polymath.example/api")).rejects.toThrow(EvalNetworkViolation);
    } finally {
      restore();
    }
  });

  it("restores the original fetch and refuses to stack", async () => {
    const restoreFirst = installNetworkGuard({ label: "first" });
    const restoreSecond = installNetworkGuard({ label: "second" });
    expect(globalThis.fetch).not.toBe(realFetch);
    restoreSecond();
    expect(globalThis.fetch).toBe(realFetch);
    // The second call returned the first guard's uninstaller, so this is a no-op.
    restoreFirst();
    expect(globalThis.fetch).toBe(realFetch);
  });
});

describe("quietStubs", () => {
  it("covers every declared tool with a unique stub id", () => {
    const stubs = quietStubs();
    const names = stubs.map((stub) => stub.tool);
    expect(names.sort()).toEqual(Object.keys(STUBBED_TOOLS).sort());
    expect(new Set(stubs.map((stub) => stub.id)).size).toBe(stubs.length);
  });
});
