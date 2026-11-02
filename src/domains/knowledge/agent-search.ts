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
 *
 * A passage below the relevance floor is not evidence, so it does not leave
 * the domain: sub-floor hits are dropped, and a search that dropped every hit
 * reports the reason instead of handing the model a weak list.
 */

export const DOCUMENTS_SEARCH_CAPABILITY = "documents.search";
export const AGENT_SEARCH_MAX_RESULTS = 10;
/** A passage is capped so one result cannot flood the model's context. */
export const AGENT_SEARCH_MAX_TEXT = 1200;

/**
 * The relevance floor on a hit's fused score, which lives on a (0, 1] scale:
 * normalized RRF is `(K / legsRun) × Σ_legs 1/(K + rank_leg)`, so rank 0 on
 * every leg scores 1.0. In hybrid mode 0.5 means both legs agree, or a single
 * leg ranks the passage first; in text mode (one leg) it drops nothing an @@
 * match already admitted. A passage below the floor is not evidence.
 */
export const AGENT_SEARCH_MIN_SCORE = 0.5;

export type DocumentCitation = {
  documentId: string;
  title: string;
  text: string;
  span: { start: number; end: number; page: number | null };
};

export type AgentSearchResult =
  | {
      ok: true;
      query: string;
      results: DocumentCitation[];
      mode: "semantic" | "text" | "hybrid";
      /** Present when hits came back but every one fell below the floor. */
      reason?: "no_relevant_passages";
    }
  | { ok: false; error: string };

/** Rank 0 counts as 1/60, rank 1 as 1/61 - the same K the artifact search uses. */
const RRF_K = 60;

/**
 * A hit with its normalized fused score on a (0, 1] scale — see
 * `AGENT_SEARCH_MIN_SCORE` for the calibration.
 */
export type ScoredHit = ChunkHit & { fusedScore: number };

/**
 * Reciprocal rank fusion over the two chunk rankings, normalized by how many
 * legs ran (`legsRun`, default: two only when both brought hits) so the two
 * modes share one 0–1 scale: a passage both sides found at rank 0 scores 1.0.
 * A passage only one side found still ranks on its single contribution, so a
 * miss on either leg degrades to the other's ordering, never to zero. Hits
 * carry no calibrated score across legs, which is exactly why rank-only
 * fusion works. First side wins on a shared key, keeping its span and text.
 */
export function rrfMerge(
  ftsHits: ChunkHit[],
  vectorHits: ChunkHit[],
  limit: number,
  input?: { legsRun?: number },
): ScoredHit[] {
  const legsRun = input?.legsRun ?? (ftsHits.length && vectorHits.length ? 2 : 1);
  const rrf = (rank: number) => RRF_K / legsRun / (RRF_K + rank);
  const scores = new Map<string, { hit: ChunkHit; score: number }>();
  const add = (hits: ChunkHit[]) =>
    hits.forEach((hit, i) => {
      const key = `${hit.documentId}:${hit.extractionId}:${hit.chunkIndex}`;
      const entry = scores.get(key);
      if (entry) {
        entry.score += rrf(i);
        // First side keeps its passage text, but an FTS passage has no page -
        // backfill it from the same passage's vector hit when one saw it.
        if (entry.hit.span.page == null && hit.span.page != null) {
          entry.hit = { ...entry.hit, span: { ...entry.hit.span, page: hit.span.page } };
        }
      } else scores.set(key, { hit, score: rrf(i) });
    });
  add(ftsHits);
  add(vectorHits);
  // One passage per document: a repeated-text document fills every chunk with
  // the query terms, and without this its chunks crowd the other documents
  // out of the citation list. The best-fused chunk stands for its document.
  const seen = new Set<string>();
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .filter((s) => (seen.has(s.hit.documentId) ? false : (seen.add(s.hit.documentId), true)))
    .slice(0, limit)
    .map((s) => ({ ...s.hit, fusedScore: s.score }));
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
    let hits: ScoredHit[];
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
      hits = rrfMerge(ftsHits, vectorHits, limit, { legsRun: 2 });
      mode = "hybrid";
    } catch (cause) {
      if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
      // No embedding key is a deployment gap, not a reason to fail closed:
      // answer from Postgres full-text over the same current extractions and
      // label the mode so the model can say how the passage was found.
      hits = rrfMerge(await searchChunksFts(auth, { query, limit, documentIds }), [], limit, { legsRun: 1 });
      mode = "text";
    }
    // A passage below the floor is not evidence, so it does not leave the
    // domain. Dropping every hit is still a successful search: the model gets
    // an empty list plus the reason, never an error.
    const relevant = hits.filter((h) => h.fusedScore >= AGENT_SEARCH_MIN_SCORE);
    return {
      ok: true,
      query,
      mode,
      ...(hits.length > 0 && relevant.length === 0 ? { reason: "no_relevant_passages" as const } : {}),
      results: relevant.map((h) => ({
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
