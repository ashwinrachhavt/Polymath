import { describe, expect, it, vi } from "vitest";
import { defaultZettelExtractor, openRouterZettelExtractor } from "@/integrations/zettels/extractor";
import { EmbeddingUnconfiguredError } from "@/integrations/embeddings/provider";

vi.mock("@/domains/billing/resolver", async () =>
  (await import("../helpers/house-generation-resolver")).houseGenerationResolver(),
);

const env = { OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv;
const reply = (content: string, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status }));

describe("openRouterZettelExtractor", () => {
  it("needs a key", () => {
    expect(() => openRouterZettelExtractor({} as NodeJS.ProcessEnv)).toThrow(EmbeddingUnconfiguredError);
  });
  it("parses the model's JSON and sends the document as data", async () => {
    const f = reply(JSON.stringify({ zettels: [{ title: "T", content: "C", quote: "Q" }] }));
    const out = await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    expect(out).toEqual([{ title: "T", content: "C", quote: "Q" }]);
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[1]).toEqual({ role: "user", content: "doc text" });
  });
  it("keeps a candidate that names no quote - the quote is optional evidence", async () => {
    const f = reply(JSON.stringify({ zettels: [{ title: "T", content: "C" }] }));
    const out = await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    expect(out).toEqual([{ title: "T", content: "C" }]);
  });
  it("fails closed on junk and on HTTP errors without keeping provider text", async () => {
    await expect(
      openRouterZettelExtractor(env, reply("not json") as unknown as typeof fetch).extract("x"),
    ).rejects.toThrow("unreadable");
    await expect(
      openRouterZettelExtractor(env, reply("secret", 500) as unknown as typeof fetch).extract("x"),
    ).rejects.toThrow("(HTTP 500)");
  });
});

describe("the content contract (LLM-chosen length, verbatim quote)", () => {
  it("asks for content of whatever length the idea needs and never padding", async () => {
    const f = reply(JSON.stringify({ zettels: [] }));
    await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const system: string = body.messages[0].content;
    expect(system).toContain('"content"');
    expect(system).toContain("As long as the idea needs");
    expect(system).toContain("one sentence to a few paragraphs");
    expect(system).toContain("Never pad, never truncate");
    expect(system).toContain("Short ideas get short cards");
    // The fixed one-sentence claim rule is retired.
    expect(system).not.toContain("standalone sentence");
  });

  it("keeps the verbatim-quote rule and allows omitting the quote", async () => {
    const f = reply(JSON.stringify({ zettels: [] }));
    await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const system: string = body.messages[0].content;
    expect(system).toContain("VERBATIM");
    expect(system).toContain('Omit "quote"');
  });
});

describe("defaultZettelExtractor", () => {
  it("resolves through the generation seam with OpenRouter as the status quo", async () => {
    const x = await defaultZettelExtractor("w1", { OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv);
    expect(x.name).toBe("openrouter:openai/gpt-4o-mini");
  });

  it("routes the Gemini free tier through the quota ledger when a workspace is known", async () => {
    const events: string[] = [];
    const store = {
      async reserve() {
        events.push("reserve");
        return { bucketId: "b", reservationId: "r" };
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
            candidates: [
              {
                content: {
                  parts: [
                    { text: JSON.stringify({ zettels: [{ title: "T", content: "C", quote: "verbatim passage" }] }) },
                  ],
                },
              },
            ],
          }),
        ),
    );
    const x = await defaultZettelExtractor(
      "w1",
      { GENERATION_PROVIDER: "gemini", GEMINI_API_KEY: "g" } as unknown as NodeJS.ProcessEnv,
      f as unknown as typeof fetch,
      store,
    );
    expect(x.name).toBe("gemini:gemini-3.5-flash-lite");
    const out = await x.extract("doc text");
    expect(out).toEqual([{ title: "T", content: "C", quote: "verbatim passage" }]);
    expect(events).toEqual(["reserve", "settle"]);
  });
});

describe("the size-derived cap (capForSize wiring)", () => {
  const one = { title: "T", content: "C", quote: "Q" };

  it("asks for at most `max` in the prompt when one is passed", async () => {
    const f = reply(JSON.stringify({ zettels: [one] }));
    await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text", { max: 5 });
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Return at most 5");
  });

  it("keeps the historical flat 8 when no cap is passed", async () => {
    const f = reply(JSON.stringify({ zettels: [one] }));
    await openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text");
    const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.messages[0].content).toContain("Return at most 8");
  });

  it("fails closed when the model returns more than the cap", async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ ...one, title: `T${i}` }));
    const f = reply(JSON.stringify({ zettels: six }));
    await expect(
      openRouterZettelExtractor(env, f as unknown as typeof fetch).extract("doc text", { max: 5 }),
    ).rejects.toThrow("unreadable");
  });
});
