import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The Composio inline-execution seam. These tests exist for the guards: a
 * write-shaped method must never reach a provider, and a misconfigured
 * deployment must say so rather than throw mid-turn.
 */

describe("executeComposioRead", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses a write method before any network call", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { executeComposioRead, ComposioReadOnlyViolationError } = await import(
      "@/domains/integrations/composio"
    );

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      await expect(
        executeComposioRead({
          connectedAccountId: "ca_1",
          endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
          method,
        }),
      ).rejects.toBeInstanceOf(ComposioReadOnlyViolationError);
    }
    // The guard must run before the request: a provider must not see the call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports not-configured without the API key", async () => {
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
    });
    expect(result).toEqual({ ok: false, code: "not_configured", message: expect.any(String) });
  });

  it("sends the connected account, method, and parameters to the proxy", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { messages: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { executeComposioRead } = await import("@/domains/integrations/composio");

    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
      query: { maxResults: "5" },
      headers: { "x-custom": "v" },
    });

    expect(result).toEqual({ ok: true, data: { messages: [] } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/tools/execute/proxy");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as {
      connected_account_id: string;
      endpoint: string;
      method: string;
      parameters: { name: string; value: string; type: string }[];
    };
    expect(body.connected_account_id).toBe("ca_1");
    expect(body.method).toBe("GET");
    expect(body.parameters).toEqual(
      expect.arrayContaining([
        { name: "x-custom", value: "v", type: "header" },
        { name: "maxResults", value: "5", type: "query" },
      ]),
    );
  });

  it("accepts a bare provider body as well as the wrapped shape", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [1] }) }),
    );
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://www.googleapis.com/x",
      method: "GET",
    });
    expect(result).toEqual({ ok: true, data: { items: [1] } });
  });

  it("turns an unreachable provider into a result, not a thrown error", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
  });

  it("reports a non-2xx provider status with the status code", async () => {
    // A rate-limited or revoked connection is the common failure; the agent
    // needs to see which status, not a generic "failed".
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("429");
  });

  it("reports an unparseable provider body as provider_error", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError("not json");
        },
      }),
    );
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "GET",
    });
    expect(result).toMatchObject({ ok: false, code: "provider_error" });
  });

  it("permits HEAD as a read", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal("fetch", fetchMock);
    const { executeComposioRead } = await import("@/domains/integrations/composio");
    const result = await executeComposioRead({
      connectedAccountId: "ca_1",
      endpoint: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      method: "HEAD",
    });
    expect(result).toMatchObject({ ok: true });
  });
});

describe("connected_read tool guards", () => {
  /*
   * The host allowlist is the difference between "read the owner's mail" and
   * "send the owner's connected credential to an arbitrary server". It is
   * checked inside the tool, so it is tested at the boundary the tool exposes.
   */
  it("rejects a non-allowlisted host and a non-https scheme", async () => {
    const mod = await import("../../eve/alfred/agent/tools/connected_read");
    const tool = mod.default as unknown as {
      execute: (
        input: unknown,
        ctx: unknown,
      ) => Promise<{ ok: boolean; error?: string }>;
    };

    const ctx = {
      session: {
        id: "wrun_x",
        auth: { current: { attributes: { workspaceId: "ws-1" }, principalId: "u-1" } },
      },
    };

    const offHost = await tool.execute(
      { provider: "gmail", url: "https://evil.example.com/collect" },
      ctx,
    );
    expect(offHost.ok).toBe(false);
    expect(offHost.error).toContain("gmail reads must target https");

    const insecure = await tool.execute(
      { provider: "gmail", url: "http://gmail.googleapis.com/gmail/v1/users/me" },
      ctx,
    );
    expect(insecure.ok).toBe(false);
  });

  it("confines a calendar read to the calendar API on a shared host", async () => {
    // www.googleapis.com serves Drive, Docs, Sheets and more. A host-only
    // allowlist would let the model aim the owner's Google grant at any of
    // them, so the path prefix is part of the contract. Drive is rejected
    // before any DB or account lookup runs.
    const tool = (await import("../../eve/alfred/agent/tools/connected_read")).default as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    const ctx = {
      session: { id: "wrun_x", auth: { current: { attributes: { workspaceId: "ws-1" }, principalId: "u-1" } } },
    };

    const drive = await tool.execute(
      { provider: "google-calendar", url: "https://www.googleapis.com/drive/v3/files" },
      ctx,
    );
    expect(drive.ok).toBe(false);
    expect(drive.error).toContain("/calendar/v3/");

    const creds = await tool.execute(
      { provider: "gmail", url: "https://user:pass@gmail.googleapis.com/gmail/v1/users/me" },
      ctx,
    );
    expect(creds.ok).toBe(false);
    expect(creds.error).toContain("no credentials");
  });

  /*
   * The policy and run-binding guards decide whether the owner's connected
   * account can be read at all. The host allowlist is not a substitute: a
   * host that passes but a capability the run does not hold must still deny.
   */
  it("denies a read when the capability is missing from the frozen policy", async () => {
    vi.resetModules();
    const getRun = vi.fn().mockResolvedValue({
      id: "run-1",
      state: "running",
      // The snapshot a run holds when documents.search is allowed but gmail.read is not.
      policySnapshot: { allowedTools: ["documents.search"] },
      subjects: [],
    });
    vi.doMock("@/domains/agents/queries", () => ({ getRunBySessionRef: getRun }));

    const tool = (await import("../../eve/alfred/agent/tools/connected_read")).default as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    const ctx = {
      session: { id: "wrun_x", auth: { current: { attributes: { workspaceId: "ws-1" }, principalId: "u-1" } } },
    };

    const denied = await tool.execute({ provider: "gmail", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" }, ctx);
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain("gmail.read is not in this run's policy snapshot");

    vi.doUnmock("@/domains/agents/queries");
    vi.resetModules();
  });

  it("denies a read when no live run is bound to the session", async () => {
    vi.resetModules();
    const getRun = vi.fn().mockResolvedValue({ id: "run-1", state: "succeeded", policySnapshot: { allowedTools: ["gmail.read"] } });
    vi.doMock("@/domains/agents/queries", () => ({ getRunBySessionRef: getRun }));

    const tool = (await import("../../eve/alfred/agent/tools/connected_read")).default as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    const ctx = {
      session: { id: "wrun_x", auth: { current: { attributes: { workspaceId: "ws-1" }, principalId: "u-1" } } },
    };

    const result = await tool.execute({ provider: "gmail", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no active Polymath run");

    vi.doUnmock("@/domains/agents/queries");
    vi.resetModules();
  });

  it("denies a read when the session carries no workspace", async () => {
    const tool = (await import("../../eve/alfred/agent/tools/connected_read")).default as unknown as {
      execute: (input: unknown, ctx: unknown) => Promise<{ ok: boolean; error?: string }>;
    };
    const ctx = { session: { id: "wrun_x", auth: { current: { attributes: {}, principalId: "u-1" } } } };
    const result = await tool.execute({ provider: "gmail", url: "https://gmail.googleapis.com/gmail/v1/users/me/messages" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("no workspace in session");
  });
});
