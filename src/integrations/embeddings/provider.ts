import { createOpenAI } from "@ai-sdk/openai";
import { embedMany } from "ai";

/*
 * The one shape embedding adapters implement. Domain code sees only this, and
 * `embeddings.model` records which model wrote a vector, so a model change is a
 * new set of chunks rather than a silent mix in one index. The schema column is
 * vector(1536), so a provider must return exactly EMBEDDING_DIMENSIONS values.
 */

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  /** Stored with every vector, e.g. "openai:text-embedding-3-small". */
  readonly model: string;
  /** The signal bounds a hung call; providers must pass it to their transport. */
  embed(values: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

export class EmbeddingUnconfiguredError extends Error {
  constructor() {
    super("No embedding provider configured. Set OPENROUTER_API_KEY (or OPENAI_API_KEY).");
    this.name = "EmbeddingUnconfiguredError";
  }
}

const OPENAI_MODEL = "text-embedding-3-small"; // 1536 dimensions, matching the schema
const OPENROUTER_URL = "https://openrouter.ai/api/v1/embeddings";
const OPENROUTER_DEFAULT_MODEL = "openai/text-embedding-3-small";
const BATCH_SIZE = 64;

/**
 * Pick the adapter from the environment. EMBEDDING_PROVIDER=openrouter|openai
 * wins; otherwise OpenRouter is used when OPENROUTER_API_KEY is set, then OpenAI.
 */
export function embeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const choice = env.EMBEDDING_PROVIDER?.toLowerCase();
  if (choice === "openrouter" || (!choice && env.OPENROUTER_API_KEY)) {
    return openRouterProvider(env);
  }
  if (choice === "openai" || (!choice && env.OPENAI_API_KEY)) {
    return openAiProvider(env);
  }
  throw new EmbeddingUnconfiguredError();
}

function openAiProvider(env: NodeJS.ProcessEnv): EmbeddingProvider {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new EmbeddingUnconfiguredError();
  const openai = createOpenAI({ apiKey });
  return {
    model: `openai:${OPENAI_MODEL}`,
    async embed(values, options) {
      const { embeddings } = await embedMany({
        model: openai.embedding(OPENAI_MODEL),
        values,
        maxParallelCalls: 2,
        abortSignal: options?.signal,
      });
      return embeddings;
    },
  };
}

/**
 * OpenRouter exposes an OpenAI-compatible POST /api/v1/embeddings with a
 * `dimensions` parameter, so any model it lists can fill the 1536-wide column.
 * Error bodies are never kept: a failure surfaces a generic message with the
 * status code only.
 */
export function openRouterProvider(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): EmbeddingProvider {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new EmbeddingUnconfiguredError();
  const model = env.EMBEDDING_MODEL || OPENROUTER_DEFAULT_MODEL;
  return {
    model: `openrouter:${model}`,
    async embed(values, options) {
      const out: number[][] = [];
      for (let i = 0; i < values.length; i += BATCH_SIZE) {
        const batch = values.slice(i, i + BATCH_SIZE);
        const res = await fetchImpl(OPENROUTER_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: batch, dimensions: EMBEDDING_DIMENSIONS }),
          signal: options?.signal ?? null,
        });
        if (!res.ok) throw new Error(`Embedding request failed (HTTP ${res.status}).`);
        const json = (await res.json()) as { data?: { index: number; embedding: number[] }[] };
        const rows = [...(json.data ?? [])].sort((a, b) => a.index - b.index);
        if (rows.length !== batch.length) throw new Error("Embedding response had the wrong size.");
        for (const r of rows) {
          if (r.embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(`Embedding model returned ${r.embedding.length} dimensions, expected ${EMBEDDING_DIMENSIONS}.`);
          }
          out.push(r.embedding);
        }
      }
      return out;
    },
  };
}
