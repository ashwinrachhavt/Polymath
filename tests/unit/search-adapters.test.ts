import { afterEach, describe, expect, it, vi } from "vitest";
import { aiGatewaySearchProvider } from "@/integrations/search/ai-gateway";
import { parallelProvider } from "@/integrations/search/parallel";
import { WebSearchError } from "@/integrations/search/provider";

/*
 * Value: protects=parallelProvider.search() result normalization (url-less hits
 * skipped, title falls back to url, excerpts joined, publish_date passthrough)
 * and its non-2xx error; fails_when=the normalization loop drops valid hits or
 * an error status resolves instead of throwing; why_new=web-search.test.ts only
 * covers provider SELECTION, never the fetch/parse body; seam=none;
 * no_claim=live Parallel API acceptance (fetch stubbed; unit only).
 *
 * Value: protects=aiGatewaySearchProvider content handling (string vs array
 * parts, empty content -> []) and non-2xx error; fails_when=an array-shaped
 * answer yields "" or a failed call throws nothing; why_new=no test exercises
 * the gateway body; seam=none; no_claim=gateway server-tool acceptance
 * (fetch stubbed; unit only).
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parallelProvider.search()", () => {
  it("normalizes hits: skips url-less, falls back to url for title, joins excerpts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              { url: "https://a.dev", title: "A", publish_date: "2026-01-02", excerpts: ["one", "two"] },
              { title: "no url here" },
              { url: "https://b.dev" },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const provider = parallelProvider({ PARALLEL_API_KEY: "k" });
    const results = await provider.search("q", 5);
    expect(results).toEqual([
      { title: "A", url: "https://a.dev", snippet: "one\ntwo", publishedAt: "2026-01-02" },
      { title: "https://b.dev", url: "https://b.dev", snippet: "", publishedAt: null },
    ]);
  });

  it("throws WebSearchError on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 401 })));
    const provider = parallelProvider({ PARALLEL_API_KEY: "k" });
    await expect(provider.search("q", 5)).rejects.toThrow(WebSearchError);
  });
});

describe("aiGatewaySearchProvider.search()", () => {
  it("reads a string content answer into one synthesized result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ choices: [{ message: { content: "The answer, cited." } }] }),
          { status: 200 },
        ),
      ),
    );
    const provider = aiGatewaySearchProvider("tako", { AI_GATEWAY_API_KEY: "k" });
    const results = await provider.search("q", 5);
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe("The answer, cited.");
  });

  it("joins array content parts into the snippet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }), {
          status: 200,
        }),
      ),
    );
    const provider = aiGatewaySearchProvider("exa", { AI_GATEWAY_API_KEY: "k" });
    const results = await provider.search("q", 5);
    expect(results.map((r) => r.snippet)).toEqual(["ab"]);
  });

  it("returns [] when content is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })),
    );
    const provider = aiGatewaySearchProvider("exa", { AI_GATEWAY_API_KEY: "k" });
    expect(await provider.search("q", 5)).toEqual([]);
  });

  it("throws WebSearchError on a non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 503 })));
    const provider = aiGatewaySearchProvider("parallel", { AI_GATEWAY_API_KEY: "k" });
    await expect(provider.search("q", 5)).rejects.toThrow(WebSearchError);
  });
});
