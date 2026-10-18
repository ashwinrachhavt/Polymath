import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnconfiguredError,
  embeddingProvider,
  openRouterProvider,
} from "@/integrations/embeddings/provider";

const vec = () => Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0.1);
const ok = (n: number) =>
  new Response(JSON.stringify({ data: Array.from({ length: n }, (_, i) => ({ index: n - 1 - i, embedding: vec() })) }));

describe("embeddingProvider selection", () => {
  it("throws unconfigured without keys", () => {
    expect(() => embeddingProvider({} as NodeJS.ProcessEnv)).toThrow(EmbeddingUnconfiguredError);
  });
  it("prefers OpenRouter when its key is set", () => {
    const p = embeddingProvider({ OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "o" } as unknown as NodeJS.ProcessEnv);
    expect(p.model).toBe("openrouter:openai/text-embedding-3-small");
  });
  it("honours EMBEDDING_PROVIDER=openai", () => {
    const p = embeddingProvider({ EMBEDDING_PROVIDER: "openai", OPENROUTER_API_KEY: "k", OPENAI_API_KEY: "o" } as unknown as NodeJS.ProcessEnv);
    expect(p.model).toBe("openai:text-embedding-3-small");
  });
});

describe("openRouterProvider", () => {
  it("requests 1536 dimensions and batches", async () => {
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.dimensions).toBe(EMBEDDING_DIMENSIONS);
      return ok(body.input.length);
    });
    const p = openRouterProvider({ OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, f as unknown as typeof fetch);
    const out = await p.embed(Array.from({ length: 70 }, (_, i) => `t${i}`));
    expect(out).toHaveLength(70);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("rejects wrong dimensions and hides provider error text", async () => {
    const bad = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 2] }] })));
    const p = openRouterProvider({ OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, bad as unknown as typeof fetch);
    await expect(p.embed(["a"])).rejects.toThrow(/dimensions/);
    const fail = vi.fn(async () => new Response("secret detail", { status: 401 }));
    const q = openRouterProvider({ OPENROUTER_API_KEY: "k" } as unknown as NodeJS.ProcessEnv, fail as unknown as typeof fetch);
    await expect(q.embed(["a"])).rejects.toThrow("Embedding request failed (HTTP 401).");
  });
});
