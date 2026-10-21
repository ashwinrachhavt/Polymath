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
    // A developer's .env leaks into the runner; the case under test is the
    // absent key, so it is removed explicitly rather than assumed absent.
    delete process.env.COMPOSIO_API_KEY;
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
