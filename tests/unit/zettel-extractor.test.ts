import { describe, expect, it, vi } from "vitest";
import { openRouterZettelExtractor } from "@/integrations/zettels/extractor";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";

const env = { OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const reply = (content: string, status = 200) => vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));

describe("openRouterZettelExtractor", () => {
  it("needs a key", () => {
    expect(() => openRouterZettelExtractor({} as NodeJS.ProcessEnv)).toThrow(EmbeddingUnconfiguredError);
  });
  it("parses the model's JSON and sends the document as data", async () => {
    const f = reply(JSON.stringify({ zettels: [{ title: "T", claim: "C", quote: "Q" }] }));
    const out = await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    expect(out).toEqual([{ title: "T", claim: "C", quote: "Q" }]);
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[1]).toEqual({ role: "user", content: "doc text" });
  });
  it("fails closed on junk and on HTTP errors without keeping provider text", async () => {
    await expect(openRouterZettelExtractor(env, reply("not json") as unknown as typeof fetch).extract("x")).rejects.toThrow("unreadable");
    await expect(openRouterZettelExtractor(env, reply("secret", 500) as unknown as typeof fetch).extract("x")).rejects.toThrow("(HTTP 500)");
  });
});
