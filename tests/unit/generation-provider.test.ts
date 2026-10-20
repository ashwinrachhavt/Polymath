import { describe, expect, it } from "vitest";
import { generationProvider, GenerationUnconfiguredError } from "@/integrations/generation/provider";
import { geminiProvider } from "@/integrations/generation/gemini";
import { openRouterProvider } from "@/integrations/generation/openrouter";

const geminiOk = () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hello " }, { text: "world" }] } }] }));
const openRouterOk = () => new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }));

describe("generationProvider selection", () => {
  it("throws unconfigured without keys", () => {
    expect(() => generationProvider({})).toThrow(GenerationUnconfiguredError);
  });
  it("keeps the OpenRouter status quo when its key is present", () => {
    const p = generationProvider({ OPENROUTER_API_KEY: "k", GEMINI_API_KEY: "g" });
    expect(p.registryId).toBe("openrouter");
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
