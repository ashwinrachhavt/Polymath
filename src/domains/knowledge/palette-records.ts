import type { AuthContext } from "@/domains/identity/resolve";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { searchKnowledge, type SearchFilters, type SearchHit, type SearchResult } from "./retrieval";

/*
 * The ⌘K palette's second phase (spec: one search language everywhere). The
 * fast first phase (searchWorkspace) answers by title across the record
 * tables in a few milliseconds; this pass ranks the one artifact store with
 * the hybrid engine - body text and meaning, the same index the notes page
 * reads - so a plain-language query finds the card whose words it shares.
 * Without an embedding provider the engine degrades to keyword-only and says
 * so, exactly like the notes page; the palette never errors for want of a key.
 */

type PaletteKnowledgeRecord = {
  /** "note" matches the palette's existing note rows; every other card is "knowledge". */
  kind: "note" | "knowledge";
  id: string;
  label: string;
  context: string;
  href: string;
};

export type PaletteKnowledgeResult = {
  records: PaletteKnowledgeRecord[];
  /** "ok", or why the meaning leg did not run (unconfigured = no provider key). */
  meaning: SearchResult["meaning"];
};

/** How many knowledge cards the palette's second phase contributes. */
const PALETTE_KNOWLEDGE_LIMIT = 8;

const KIND_CONTEXT: Record<string, string> = {
  note: "Note in Polymath",
  zettel: "Zettel in Polymath",
  document: "Document in Polymath",
  memo: "Memo in Polymath",
  report: "Report in Polymath",
  transcript: "Conversation in Polymath",
};

/*
 * A row the meaning leg surfaced says so - the notes page's Why chips,
 * compressed to the palette's one context line. A plain title match says
 * nothing extra: it reads like any other row.
 */
function whyContext(hit: SearchHit): string {
  if (hit.why.titleMatch) return "";
  if (hit.why.meaningRank !== null && hit.why.similarity !== null) {
    return ` \u00b7 meaning match ${Math.round(hit.why.similarity * 100)}%`;
  }
  if (hit.why.keywordRank !== null) return " \u00b7 text match";
  return "";
}

export async function searchPaletteKnowledge(
  auth: AuthContext,
  query: string,
  opts: { provider?: EmbeddingProvider; filters?: SearchFilters; kinds?: readonly string[] } = {},
): Promise<PaletteKnowledgeResult> {
  const q = query.trim();
  if (q.length < 2) return { records: [], meaning: "off" };
  const result = await searchKnowledge(auth, {
    query: q,
    limit: PALETTE_KNOWLEDGE_LIMIT,
    provider: opts.provider,
    filters: opts.filters,
    kinds: opts.kinds,
  });
  return {
    records: result.hits.map((hit) => ({
      kind: hit.kind === "note" ? "note" : "knowledge",
      id: hit.id,
      label: hit.title,
      context: `${KIND_CONTEXT[hit.kind] ?? "Card in Polymath"}${whyContext(hit)}`,
      // Every artifact card opens in the notebook, the same href the notes
      // page's own hit list builds (search-results hrefFor).
      href: `/polymath/notes?id=${hit.id}`,
    })),
    meaning: result.meaning,
  };
}
