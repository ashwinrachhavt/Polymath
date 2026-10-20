import { describe, expect, it, vi } from "vitest";
import { defaultZettelExtractor, openRouterZettelExtractor } from "@/integrations/zettels/extractor";
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

describe("defaultZettelExtractor", () => {
  it("resolves through the generation seam with OpenRouter as the status quo", () => {
    const x = defaultZettelExtractor(undefined, { OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
    expect(x.name).toBe("openrouter:openai/gpt-4o-mini");
  });

  it("routes the Gemini free tier through the quota ledger when a workspace is known", async () => {
    const events: string[] = [];
    const store = {
      async reserve() {
        events.push("reserve");
        return { bucketId: "b" };
      },
      async settle() {
        events.push("settle");
      },
      async release() {
        events.push("release");
      },
    };
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ zettels: [{ title: "T", claim: "C", quote: "verbatim passage" }] }) }] } }],
          }),
        ),
    );
    const x = defaultZettelExtractor("w1", { GENERATION_PROVIDER: "gemini", GEMINI_API_KEY: "g" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch, store);
    expect(x.name).toBe("gemini:gemini-3.5-flash-lite");
    const out = await x.extract("doc text");
    expect(out).toEqual([{ title: "T", claim: "C", quote: "verbatim passage" }]);
    expect(events).toEqual(["reserve", "settle"]);
  });
});
