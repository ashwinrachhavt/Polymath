import { EmbeddingUnconfiguredError, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { AuthContext } from "@/domains/identity/resolve";
import { projectDocumentIds } from "./projects";
import { searchChunks, searchChunksFts, type ChunkHit } from "./search";

/*
 * What the agent's `documents.search` tool calls. A read only: with an
 * embedding provider configured it runs the vector ranking (searchChunks) and
 * the Postgres full-text ranking (searchChunksFts) in parallel and fuses them
 * by reciprocal rank (`mode: "hybrid"`) - a keyword-exact passage and a
 * semantically-close one both surface, and a miss on either leg degrades to
 * the other's ordering, never to zero. With no embedding provider it falls
 * back to full-text alone and says so (`mode: "text"`) - never a silent
 * fail-closed. It has no write path on purpose. If a run wants to change a
 * document, that goes through the existing action proposals, the one review
 * queue, never through this function.
 *
 * The workspace comes from the verified session, never from the model's
 * arguments, so a prompt cannot ask for another tenant's text.
 */

export const DOCUMENTS_SEARCH_CAPABILITY = "documents.search";
export const AGENT_SEARCH_MAX_RESULTS = 10;
/** A passage is capped so one result cannot flood the model's context. */
export const AGENT_SEARCH_MAX_TEXT = 1200;

export type DocumentCitation = {
  documentId: string;
  title: string;
  text: string;
  span: { start: number; end: number; page: number | null };
};

export type AgentSearchResult =
  | { ok: true; query: string; results: DocumentCitation[]; mode: "semantic" | "text" | "hybrid" }
  | { ok: false; error: string };

/** Rank 0 counts as 1/60, rank 1 as 1/61 - the same K the artifact search uses. */
const RRF_K = 60;

/**
 * Reciprocal rank fusion over the two chunk rankings. A passage both sides
 * found (the usual case for a keyword-exact answer) gets two contributions;
 * a passage only one side found still ranks on its single contribution, so a
 * miss on either leg degrades to the other's ordering, never to zero. Hits
 * carry no calibrated score across legs, which is exactly why rank-only
 * fusion works. First side wins on a shared key, keeping its span and text.
 */
export function rrfMerge(ftsHits: ChunkHit[], vectorHits: ChunkHit[], limit: number): ChunkHit[] {
  const rrf = (rank: number) => 1 / (RRF_K + rank);
  const scores = new Map<string, { hit: ChunkHit; score: number }>();
  const add = (hits: ChunkHit[]) =>
    hits.forEach((hit, i) => {
      const key = `${hit.documentId}:${hit.extractionId}:${hit.chunkIndex}`;
      const entry = scores.get(key);
      if (entry) entry.score += rrf(i);
      else scores.set(key, { hit, score: rrf(i) });
    });
  add(ftsHits);
  add(vectorHits);
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.hit);
}

export async function searchDocumentsForAgent(
  auth: AuthContext,
  input: { query: string; limit?: number; provider?: EmbeddingProvider; projectId?: string },
): Promise<AgentSearchResult> {
  const query = input.query.trim();
  if (!query) return { ok: false, error: "query is empty" };
  const limit = Math.min(Math.max(input.limit ?? 5, 1), AGENT_SEARCH_MAX_RESULTS);
  try {
    // A project narrows the search to its documents. An unknown or foreign
    // project is an error, never a silent search of everything.
    let documentIds: string[] | undefined;
    if (input.projectId) {
      const ids = await projectDocumentIds(auth, input.projectId);
      if (!ids) return { ok: false, error: "project not found" };
      documentIds = ids;
    }
    let hits: ChunkHit[];
    let mode: "semantic" | "text" | "hybrid" = "semantic";
    try {
      // With a provider configured, both rankings run in parallel and fuse.
      // Each side gets the full requested limit: RRF re-ranks down afterwards,
      // and a deeper list per leg is what lets the merge see past one leg's
      // noise. The per-leg limit is capped again inside each read.
      const [vectorHits, ftsHits] = await Promise.all([
        searchChunks(auth, { query, limit, provider: input.provider, documentIds }),
        searchChunksFts(auth, { query, limit, documentIds }),
      ]);
      hits = rrfMerge(ftsHits, vectorHits, limit);
      mode = "hybrid";
    } catch (cause) {
      if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
      // No embedding key is a deployment gap, not a reason to fail closed:
      // answer from Postgres full-text over the same current extractions and
      // label the mode so the model can say how the passage was found.
      hits = await searchChunksFts(auth, { query, limit, documentIds });
      mode = "text";
    }
    return {
      ok: true,
      query,
      mode,
      results: hits.map((h) => ({
        documentId: h.documentId,
        title: h.title,
        text: h.text.length > AGENT_SEARCH_MAX_TEXT ? `${h.text.slice(0, AGENT_SEARCH_MAX_TEXT)}…` : h.text,
        span: h.span,
      })),
    };
  } catch (cause) {
    if (cause instanceof EmbeddingUnconfiguredError) {
      return { ok: false, error: "document search is not configured (no embedding key)" };
    }
    // Provider text can carry account details; the model gets a fixed message.
    return { ok: false, error: "document search failed, try again" };
  }
}
