import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPageForAgent } from "@/domains/knowledge/web-fetch";

/*
 * The agent retries a read once only when the result carries `retryable`.
 * A deployment with no fetch provider must not invite that retry; a provider
 * that could not be reached must.
 */

const AUTH = { workspaceId: "workspace" };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchPageForAgent failures", () => {
  it("reports a missing provider as final", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "");
    const result = await fetchPageForAgent(AUTH, { url: "https://example.com/page" });
    expect(result).toEqual({ ok: false, error: "web fetch is not configured on this deployment" });
  });

  it("marks an unreachable provider as worth one retry", async () => {
    vi.stubEnv("FIRECRAWL_API_URL", "http://127.0.0.1:3002");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const result = await fetchPageForAgent(AUTH, { url: "https://example.com/page" });
    expect(result).toEqual({ ok: false, error: "fetch failed, try again", retryable: true });
  });
});
