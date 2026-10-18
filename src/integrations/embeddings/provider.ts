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
  embed(values: string[]): Promise<number[][]>;
}

export class EmbeddingUnconfiguredError extends Error {
  constructor() {
    super("No embedding provider configured. Set OPENAI_API_KEY.");
    this.name = "EmbeddingUnconfiguredError";
  }
}

const OPENAI_MODEL = "text-embedding-3-small"; // 1536 dimensions, matching the schema

export function embeddingProvider(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new EmbeddingUnconfiguredError();
  const openai = createOpenAI({ apiKey });
  return {
    model: `openai:${OPENAI_MODEL}`,
    async embed(values) {
      const { embeddings } = await embedMany({
        model: openai.embedding(OPENAI_MODEL),
        values,
        maxParallelCalls: 2,
      });
      return embeddings;
    },
  };
}
