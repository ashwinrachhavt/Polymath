import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* The Composio client: request shape, env gating, error surfaces. No network. */

describe("composio client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("reports not-configured without env, per provider", async () => {
    const { isComposioConfigured, createHostedConnectLink } = await import("@/domains/integrations/composio");
    expect(isComposioConfigured("gmail")).toBe(false);
    await expect(
      createHostedConnectLink({ provider: "gmail", userId: "ws-1", alias: "work-gmail", callbackUrl: "https://app.test/cb" }),
    ).rejects.toMatchObject({ code: "composio_not_configured" });
  });

  it("posts the link session with the auth config for the provider", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key");
    vi.stubEnv("COMPOSIO_AUTH_CONFIG_GMAIL", "ac_gmail_1");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ redirect_url: "https://hosted.composio.dev/x", connected_account_id: "ca_1", expires_at: "2026-10-19T02:00:00Z" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { isComposioConfigured, createHostedConnectLink } = await import("@/domains/integrations/composio");
    expect(isComposioConfigured("gmail")).toBe(true);
    expect(isComposioConfigured("slack")).toBe(false); // per-provider config

    const link = await createHostedConnectLink({
      provider: "gmail",
      userId: "ws-1",
      alias: "work-gmail",
      callbackUrl: "https://app.test/cb",
    });
    expect(link).toEqual({ redirectUrl: "https://hosted.composio.dev/x", connectedAccountId: "ca_1", expiresAt: "2026-10-19T02:00:00Z" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://backend.composio.dev/api/v3.1/connected_accounts/link");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(String(init.body))).toEqual({
      auth_config_id: "ac_gmail_1",
      user_id: "ws-1",
      alias: "work-gmail",
      callback_url: "https://app.test/cb",
    });
  });

  it("surfaces a failed link request as a plain error, never the key", async () => {
    vi.stubEnv("COMPOSIO_API_KEY", "test-key-secret");
    vi.stubEnv("COMPOSIO_AUTH_CONFIG_NOTION", "ac_notion_1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const { createHostedConnectLink } = await import("@/domains/integrations/composio");
    await expect(
      createHostedConnectLink({ provider: "notion", userId: "ws-1", alias: "wiki", callbackUrl: "https://app.test/cb" }),
    ).rejects.toThrow(/failed \(401\)/);
    await expect(
      createHostedConnectLink({ provider: "notion", userId: "ws-1", alias: "wiki", callbackUrl: "https://app.test/cb" }),
    ).rejects.not.toThrow(/test-key-secret/);
  });
});
