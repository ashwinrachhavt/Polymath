import { EmbeddingUnconfiguredError, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import type { AuthContext } from "@/domains/identity/resolve";
import { dossierDocumentIds } from "./dossiers";
import { searchChunks, searchChunksFts, type ChunkHit } from "./search";

/*
 * What the agent's `documents.search` tool calls. A read only: it embeds the
 * question, asks searchChunks (which scopes every row to auth.workspaceId) for
 * the nearest passages, and returns them in the shape the model and the
 * citation list both want. With no embedding provider configured it falls
 * back to Postgres full-text over the same current extractions and says so
 * (`mode: "text"`) - keyword matching instead of semantic similarity, never
 * a silent fail-closed. It has no write path on purpose. If a run wants to
 * change a document, that goes through the existing action proposals, the one
 * review queue, never through this function.
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
  | { ok: true; query: string; results: DocumentCitation[]; mode: "semantic" | "text" }
  | { ok: false; error: string };

export async function searchDocumentsForAgent(
  auth: AuthContext,
  input: { query: string; limit?: number; provider?: EmbeddingProvider; dossierId?: string },
): Promise<AgentSearchResult> {
  const query = input.query.trim();
  if (!query) return { ok: false, error: "query is empty" };
  const limit = Math.min(Math.max(input.limit ?? 5, 1), AGENT_SEARCH_MAX_RESULTS);
  try {
    // A dossier narrows the search to its documents. An unknown or foreign
    // dossier is an error, never a silent search of everything.
    let documentIds: string[] | undefined;
    if (input.dossierId) {
      const ids = await dossierDocumentIds(auth, input.dossierId);
      if (!ids) return { ok: false, error: "dossier not found" };
      documentIds = ids;
    }
    let hits: ChunkHit[];
    let mode: "semantic" | "text" = "semantic";
    try {
      hits = await searchChunks(auth, { query, limit, provider: input.provider, documentIds });
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

/** Distinct citations across tool results, one per document span, in first-seen order. */
export function collectCitations(results: unknown[]): DocumentCitation[] {
  const seen = new Set<string>();
  const out: DocumentCitation[] = [];
  for (const result of results) {
    const list = (result as { results?: unknown } | null)?.results;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const c = item as Partial<DocumentCitation>;
      if (typeof c.documentId !== "string" || typeof c.title !== "string" || typeof c.text !== "string") continue;
      const start = c.span?.start ?? 0;
      const key = `${c.documentId}:${start}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ documentId: c.documentId, title: c.title, text: c.text, span: { start, end: c.span?.end ?? start, page: c.span?.page ?? null } });
    }
  }
  return out;
}
