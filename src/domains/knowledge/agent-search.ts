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
const AGENT_SEARCH_MAX_TEXT = 1200;

/**
 * @deprecated The absolute fused-score floor is removed (issue #533 finding
 * 3): a single leg's rank-1 hit scored below it while a rank-0 hit scored
 * exactly at it, so the floor was measuring leg count, not relevance.
 * Admission is `isEvidence` on leg provenance; this constant stays only so
 * older callers fail loudly at import instead of silently changing meaning.
 */
export const AGENT_SEARCH_MIN_SCORE = 0.5;

export type DocumentCitation = {
  documentId: string;
  title: string;
  text: string;
  span: { start: number; end: number; page: number | null };
  /** Passage lineage (issue #533 finding 6): the citation resolves to the
   * pinned extraction and canonical passage, not only the document. Always
   * set on fresh search results; optional because persisted historical
   * answers predate the lineage. */
  extractionId?: string;
  chunkIndex?: number;
  /** Embedding coverage of the cited extraction: "partial" means a long
   * document's tail is not vector-searchable, so an empty or thin result for
   * it must not be read as "the document says nothing about this" (issue
   * #533 finding 5). */
  coverage?: string | null;
};

export type AgentSearchResult =
  | {
      ok: true;
      query: string;
      results: DocumentCitation[];
      mode: "semantic" | "text" | "hybrid";
      /** Present when one leg failed and the other answered alone (issue #533
       * finding 4): the model must know retrieval ran degraded. */
      degraded?: "vector_leg_failed" | "fts_leg_failed";
      /** Present when hits came back but none passed the evidence rule. */
      reason?: "no_relevant_passages";
    }
  | { ok: false; error: string };

/** Rank 0 counts as 1/60, rank 1 as 1/61 - the same K the artifact search uses. */
const RRF_K = 60;

export type SearchLeg = "fts" | "vector";

/**
 * A hit with its normalized fused score PLUS the provenance the score alone
 * hid (issue #533 finding 3): which legs saw it and each leg's best rank.
 * fusedScore orders; it is not calibrated answerability and is never the
 * admission test.
 */
export type ScoredHit = ChunkHit & {
  fusedScore: number;
  legs: SearchLeg[];
  bestRank: { fts?: number; vector?: number };
};

/**
 * The most passages one document may contribute to one result (issue #533
 * finding 1): questions that need two distant sections of ONE document were
 * starved by the old one-passage-per-document dedupe. Overlapping passages
 * are already one fusion key, so this budget bounds crowding without
 * dropping distinct evidence.
 */
export const AGENT_SEARCH_PER_DOCUMENT_LIMIT = 3;

/**
 * EXPERIMENTAL - unmeasured admission rule, pending the Phase-1 evaluation
 * set's measured threshold (issue #533 finding 3). Both legs agreeing is
 * treated as evidence, but dual-leg agreement alone does not PROVE relevance;
 * a hit a single leg saw must sit at or under this rank in that leg. Rank
 * ordering and relevance admission are separate decisions on purpose. Do not
 * treat this policy as calibrated until the retrieval evaluation reports
 * recall/precision for it against alternatives.
 */
export const AGENT_SEARCH_SINGLE_LEG_MAX_RANK = 2;

/** Is this hit evidence the model may see? Rank provenance, never the fused score, answers. EXPERIMENTAL until measured - see above. */
export function isEvidence(hit: ScoredHit): boolean {
  if (hit.legs.length > 1) return true;
  const rank = hit.bestRank.fts ?? hit.bestRank.vector ?? Number.POSITIVE_INFINITY;
  return rank <= AGENT_SEARCH_SINGLE_LEG_MAX_RANK;
}

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
  input?: { legsRun?: number; perDocumentLimit?: number },
): ScoredHit[] {
  const legsRun = input?.legsRun ?? (ftsHits.length && vectorHits.length ? 2 : 1);
  const perDocumentLimit = input?.perDocumentLimit ?? AGENT_SEARCH_PER_DOCUMENT_LIMIT;
  const rrf = (rank: number) => RRF_K / legsRun / (RRF_K + rank);
  const scores = new Map<
    string,
    { hit: ChunkHit; score: number; legs: Set<SearchLeg>; bestRank: { fts?: number; vector?: number } }
  >();
  const add = (hits: ChunkHit[], leg: SearchLeg) =>
    hits.forEach((hit, i) => {
      const key = `${hit.documentId}:${hit.extractionId}:${hit.chunkIndex}`;
      const entry = scores.get(key);
      if (entry) {
        entry.score += rrf(i);
        entry.legs.add(leg);
        const seen = entry.bestRank[leg];
        entry.bestRank[leg] = seen === undefined ? i : Math.min(seen, i);
        // First side keeps its passage text, but an FTS passage has no page -
        // backfill it from the same passage's vector hit when one saw it.
        // Coverage backfills the same way: either leg may carry it.
        if (entry.hit.span.page == null && hit.span.page != null) {
          entry.hit = { ...entry.hit, span: { ...entry.hit.span, page: hit.span.page } };
        }
        if (entry.hit.coverage == null && hit.coverage != null) {
          entry.hit = { ...entry.hit, coverage: hit.coverage };
        }
      } else {
        scores.set(key, { hit, score: rrf(i), legs: new Set([leg]), bestRank: { [leg]: i } });
      }
    });
  add(ftsHits, "fts");
  add(vectorHits, "vector");
  // One document may contribute up to perDocumentLimit DISTINCT passages
  // (issue #533 finding 1): distant sections of one document are real
  // evidence, while a repeated-text document still cannot crowd every other
  // document out of the citation list.
  const perDocument = new Map<string, number>();
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .filter((entry) => {
      const used = perDocument.get(entry.hit.documentId) ?? 0;
      if (used >= perDocumentLimit) return false;
      perDocument.set(entry.hit.documentId, used + 1);
      return true;
    })
    .slice(0, limit)
    .map((entry) => ({
      ...entry.hit,
      fusedScore: entry.score,
      legs: [...entry.legs],
      bestRank: entry.bestRank,
    }));
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
    // Each leg fails independently (issue #533 finding 4): a transient
    // embedding outage must not take keyword search down with it, and vice
    // versa. The survivor answers alone and the result says it is degraded.
    // Each side gets the full requested limit: RRF re-ranks down afterwards,
    // and a deeper list per leg is what lets the merge see past one leg's
    // noise. The per-leg limit is capped again inside each read.
    const [vectorLeg, ftsLeg] = await Promise.allSettled([
      searchChunks(auth, { query, limit, provider: input.provider, documentIds }),
      searchChunksFts(auth, { query, limit, documentIds }),
    ]);
    const vectorHits = vectorLeg.status === "fulfilled" ? vectorLeg.value : null;
    const ftsHits = ftsLeg.status === "fulfilled" ? ftsLeg.value : null;
    if (vectorHits === null && ftsHits === null) {
      // Both legs failed: an unconfigured embedding key alone degrades to
      // text, but text search failing too is a real failure.
      if (
        vectorLeg.reason instanceof EmbeddingUnconfiguredError ||
        ftsLeg.reason instanceof EmbeddingUnconfiguredError
      ) {
        return { ok: false, error: "document search is not configured (no embedding key)" };
      }
      return { ok: false, error: "document search failed, try again" };
    }
    let hits: ScoredHit[];
    let mode: "semantic" | "text" | "hybrid";
    let degraded: "vector_leg_failed" | "fts_leg_failed" | undefined;
    if (vectorHits !== null && ftsHits !== null) {
      hits = rrfMerge(ftsHits, vectorHits, limit, { legsRun: 2 });
      mode = "hybrid";
    } else if (ftsHits !== null) {
      // Includes the no-key deployment gap: answer from Postgres full-text
      // over the same current extractions and say the vector leg was absent.
      hits = rrfMerge(ftsHits, [], limit, { legsRun: 1 });
      mode = "text";
      degraded = "vector_leg_failed";
    } else {
      hits = rrfMerge([], vectorHits!, limit, { legsRun: 1 });
      mode = "semantic";
      degraded = "fts_leg_failed";
    }
    // Rank provenance, not the fused score, decides what is evidence (issue
    // #533 finding 3). Dropping every hit is still a successful search: the
    // model gets an empty list plus the reason, never an error.
    const relevant = hits.filter(isEvidence);
    return {
      ok: true,
      query,
      mode,
      ...(degraded ? { degraded } : {}),
      ...(hits.length > 0 && relevant.length === 0 ? { reason: "no_relevant_passages" as const } : {}),
      results: relevant.map((h) => ({
        documentId: h.documentId,
        title: h.title,
        text: h.text.length > AGENT_SEARCH_MAX_TEXT ? `${h.text.slice(0, AGENT_SEARCH_MAX_TEXT)}…` : h.text,
        span: h.span,
        extractionId: h.extractionId,
        chunkIndex: h.chunkIndex,
        coverage: h.coverage,
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
