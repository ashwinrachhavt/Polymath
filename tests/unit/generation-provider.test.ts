import { describe, expect, it, vi } from "vitest";
import {
  GenerationConfigError,
  GenerationUnconfiguredError,
  generationProvider,
  type StreamChunk,
} from "@/integrations/generation/provider";
import { cloudflareProvider } from "@/integrations/generation/cloudflare";
import { fixtureProvider } from "@/integrations/generation/fixture";
import { geminiProvider } from "@/integrations/generation/gemini";
import { openRouterProvider } from "@/integrations/generation/openrouter";

const geminiOk = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] }));
const openRouterOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));

describe("generationProvider selection", () => {
  it("throws unconfigured without keys", () => {
    expect(() => generationProvider({})).toThrow(GenerationUnconfiguredError);
  });
  it("prefers the free Gemini allowance when both keys are present", () => {
    // Free-first (owner decision 2026-10-27). This used to assert OpenRouter,
    // which billed every debrief and draft while the Gemini free tier sat
    // configured and unused.
    const p = generationProvider({ OPENROUTER_API_KEY: "k", GEMINI_API_KEY: "g" });
    expect(p.registryId).toBe("gemini");
  });
  it("still generates on OpenRouter when that is the only key", () => {
    expect(generationProvider({ OPENROUTER_API_KEY: "k" }).registryId).toBe("openrouter");
  });
  it("serves the fixture provider only outside production", () => {
    expect(generationProvider({ GENERATION_PROVIDER: "fixture" }).registryId).toBe("fixture");
    expect(generationProvider({ GENERATION_PROVIDER: "fixture", NODE_ENV: "development" }).registryId).toBe("fixture");
  });
  it("fails closed if fixture is set in production", () => {
    // An env leak must surface as the skippable unconfigured error, never as
    // fixture content in front of a real caller.
    expect(() => generationProvider({ GENERATION_PROVIDER: "fixture", NODE_ENV: "production" })).toThrow(GenerationUnconfiguredError);
  });
  it("takes the free Gemini route only when it is the configured one", () => {
    expect(generationProvider({ GEMINI_API_KEY: "g" }).registryId).toBe("gemini");
    expect(generationProvider({ GENERATION_PROVIDER: "gemini", OPENROUTER_API_KEY: "k", GEMINI_API_KEY: "g" }).registryId).toBe("gemini");
  });
});

describe("geminiProvider", () => {
  it("sends system and prompt with a JSON response contract and joins the parts", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const f = async (u: unknown, i?: RequestInit) => {
      calls.push([String(u), i!]);
      return geminiOk();
    };
    const p = geminiProvider({ GEMINI_API_KEY: "g" }, f as unknown as typeof fetch);
    const out = await p.generate({ system: "sys", prompt: "doc", json: true });
    expect(out.text).toBe("hello world");
    expect(p.name).toBe("gemini:gemini-3.5-flash-lite");
    expect(calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect((calls[0][1].headers as Record<string, string>)["x-goog-api-key"]).toBe("g");
    const body = JSON.parse(String(calls[0][1].body));
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    expect(body.contents[0].parts[0].text).toBe("doc");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
  });

  it("fails closed on HTTP errors with status only", async () => {
    const f = async () => new Response("key detail", { status: 429 });
    const p = geminiProvider({ GEMINI_API_KEY: "g" }, f as unknown as typeof fetch);
    await expect(p.generate({ prompt: "x" })).rejects.toThrow("HTTP 429");
  });
});

describe("openRouterProvider", () => {
  it("keeps the pre-ASH-187 request shape", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const f = async (u: unknown, i?: RequestInit) => {
      calls.push([String(u), i!]);
      return openRouterOk();
    };
    const p = openRouterProvider({ OPENROUTER_API_KEY: "k" }, f as unknown as typeof fetch);
    const out = await p.generate({ system: "sys", prompt: "doc", json: true });
    expect(out.text).toBe("{}");
    expect(p.name).toBe("openrouter:openai/gpt-4o-mini");
    const body = JSON.parse(String(calls[0][1].body));
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "doc" },
    ]);
    expect(body.response_format).toEqual({ type: "json_object" });
  });
});

/** Collect an SSE byte stream from `data:` payload lines. */
function sseStream(payloads: unknown[]): ReadableStream<Uint8Array> {
  const lines = payloads.map((p) => `data: ${typeof p === "string" ? p : JSON.stringify(p)}\n`).join("");
  return new Response(`${lines}data: [DONE]\n`).body!;
}

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe("cloudflare provider", () => {
  it("selects cloudflare on explicit opt-in (§8) and generates with usage", async () => {
    const fetchMock = vi.fn(async () => Response.json({
      result: { response: "cf answer", usage: { prompt_tokens: 7, completion_tokens: 3 } },
    }));
    const provider = generationProvider(
      {
        GENERATION_PROVIDER: "cloudflare",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_API_KEY: "key",
        CLOUDFLARE_MODEL: "@cf/meta/llama-3.1-8b-instruct",
      },
      fetchMock as unknown as typeof fetch,
    );
    expect(provider.name).toBe("cloudflare:@cf/meta/llama-3.1-8b-instruct");
    const result = await provider.generate({ system: "sys", prompt: "hello" });
    expect(result.text).toBe("cf answer");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/meta/llama-3.1-8b-instruct");
    const body = JSON.parse(init.body as string);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("fails fast at selection with a GenerationConfigError naming the variable and what to set (§15.6)", () => {
    for (const [missing, env] of Object.entries({
      CLOUDFLARE_ACCOUNT_ID: { CLOUDFLARE_API_KEY: "k", CLOUDFLARE_MODEL: "m" },
      CLOUDFLARE_API_KEY: { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_MODEL: "m" },
      CLOUDFLARE_MODEL: { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_KEY: "k" },
    })) {
      try {
        cloudflareProvider({ GENERATION_PROVIDER: "cloudflare", ...env });
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(GenerationConfigError);
        expect(err).toBeInstanceOf(GenerationUnconfiguredError);
        expect((err as GenerationConfigError).variable).toBe(missing);
        expect((err as GenerationConfigError).expected.length).toBeGreaterThan(0);
        expect((err as Error).message).toContain(missing);
      }
    }
  });

  it("treats an unknown GENERATION_PROVIDER as the base configuration error", () => {
    expect(() => generationProvider({ GENERATION_PROVIDER: "bogus" })).toThrow(GenerationUnconfiguredError);
  });

  it("streams token chunks from SSE", async () => {
    const fetchMock = vi.fn(async () => new Response(sseStream([{ response: "Hel" }, { response: "lo" }])));
    const provider = cloudflareProvider(
      { CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_API_KEY: "k", CLOUDFLARE_MODEL: "m" },
      fetchMock as unknown as typeof fetch,
    );
    const chunks = await collect(provider.stream!({ prompt: "hi" }));
    expect(chunks).toEqual([
      { type: "token", content: "Hel" },
      { type: "token", content: "lo" },
    ]);
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).stream).toBe(true);
  });
});

describe("adapter streams", () => {
  it("gemini streams token chunks and returns usage on generate", async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.includes("streamGenerateContent")) {
        return new Response(sseStream([
          { candidates: [{ content: { parts: [{ text: "wor" }, { text: "ds" }] } }] },
          { candidates: [{ content: { parts: [{ text: "!" }] } }] },
        ]));
      }
      return Response.json({
        candidates: [{ content: { parts: [{ text: "full" }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      });
    });
    const provider = geminiProvider({ GEMINI_API_KEY: "k" }, fetchMock as unknown as typeof fetch);
    const gen = await provider.generate({ prompt: "hi" });
    expect(gen.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    const chunks = await collect(provider.stream!({ prompt: "hi" }));
    expect(chunks).toEqual([
      { type: "token", content: "words" },
      { type: "token", content: "!" },
    ]);
  });

  it("openrouter streams reasoning as thinking and content as tokens, usage on generate", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (JSON.parse(init!.body as string).stream) {
        return new Response(sseStream([
          { choices: [{ delta: { reasoning: "hmm" } }] },
          { choices: [{ delta: { content: "answer" } }] },
        ]));
      }
      return Response.json({
        choices: [{ message: { content: "full" } }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      });
    });
    const provider = openRouterProvider({ OPENROUTER_API_KEY: "k" }, fetchMock as unknown as typeof fetch);
    const gen = await provider.generate({ prompt: "hi" });
    expect(gen.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    const chunks = await collect(provider.stream!({ prompt: "hi" }));
    expect(chunks).toEqual([
      { type: "thinking", content: "hmm" },
      { type: "token", content: "answer" },
    ]);
  });

  it("fixture streams thinking then word tokens matching its generate answer", async () => {
    const provider = fixtureProvider();
    const input = { system: "You draft long-form writing from research", prompt: "go" };
    const { text } = await provider.generate(input);
    const chunks = await collect(provider.stream!(input));
    expect(chunks[0].type).toBe("thinking");
    const tokens = chunks.filter((c) => c.type === "token").map((c) => c.content).join("");
    expect(tokens.trimEnd()).toBe(text);
    expect(chunks.length).toBeGreaterThan(3);
  });
});
