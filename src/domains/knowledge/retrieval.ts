import { sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { embeddingProvider, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import { vectorLiteral } from "./embedding";

/*
 * The retrieval layer: one way to find a card, whatever asks. Instant search,
 * the link picker and related-idea suggestions all read from here, over the one
 * artifact store (notes, zettels, documents, memos, reports, transcripts).
 *
 * Two legs, both plain Postgres, both on the free tier:
 *   keyword  - full-text rank over title (weight A) and body (weight B) with
 *              websearch syntax, plus trigram word similarity on the title so a
 *              typo or a half-typed word still lands. GIN indexes (0221).
 *   meaning  - pgvector cosine over the chunk vectors the embedding pass
 *              already wrote (HNSW index, #165 provider). One vector per query.
 * Fused by reciprocal rank fusion: score = sum over legs of 1 / (K + rank).
 * RRF needs no score calibration between a BM25-style rank and a cosine
 * distance, which is why it beats weighted sums on small corpora. Without an
 * embedding provider the meaning leg is skipped and the keyword leg answers
 * alone, so search never errors for want of a key.
 */

export const RRF_K = 60;
export const LEG_DEPTH = 50;
/** Chunks closer than this are noise; cosine distance, same scale as the link edges. */
export const MEANING_MAX_DISTANCE = 0.6;
export const SEARCH_KINDS = ["note", "zettel", "document", "memo", "report", "transcript"] as const;

export type SearchMode = "hybrid" | "keyword" | "meaning";

export type SearchHit = {
  id: string;
  title: string;
  kind: string;
  /** Fused score; only comparable within one result list. */
  score: number;
  /** Why it ranked: which leg found it and where. */
  why: {
    keywordRank: number | null;
    meaningRank: number | null;
    /** 1 - cosine distance of the closest chunk, when the meaning leg found it. */
    similarity: number | null;
    titleMatch: boolean;
  };
  /** Matching passage with matches wrapped in [[ ]], or the opening line. */
  snippet: string | null;
};

export type SearchResult = {
  hits: SearchHit[];
  /** "ok", or why the meaning leg did not run. */
  meaning: "ok" | "off" | "unconfigured" | "failed";
  ms: number;
};

type KeywordRow = { id: string; rank: number; title_match: boolean };
type MeaningRow = { id: string; rank: number; distance: number };

export function fuse(keyword: { id: string }[], meaning: { id: string; distance: number }[]) {
  const scores = new Map<string, { score: number; kw: number | null; mn: number | null; distance: number | null }>();
  const entry = (id: string) => {
    let e = scores.get(id);
    if (!e) scores.set(id, (e = { score: 0, kw: null, mn: null, distance: null }));
    return e;
  };
  keyword.forEach((row, i) => {
    const e = entry(row.id);
    e.kw = i + 1;
    e.score += 1 / (RRF_K + i + 1);
  });
  meaning.forEach((row, i) => {
    const e = entry(row.id);
    e.mn = i + 1;
    e.distance = row.distance;
    e.score += 1 / (RRF_K + i + 1);
  });
  return [...scores.entries()].sort((a, b) => b[1].score - a[1].score).map(([id, e]) => ({ id, ...e }));
}

async function keywordLeg(auth: AuthContext, query: string, kinds: readonly string[]): Promise<KeywordRow[]> {
  const rows = await db.execute(sql`
    select a.id,
           (a.title ilike '%' || ${query} || '%' or ${query} <% a.title) as title_match,
           row_number() over (order by
             ts_rank_cd(
               setweight(to_tsvector('english', a.title), 'A') || setweight(to_tsvector('english', coalesce(v.plain_text, '')), 'B'),
               websearch_to_tsquery('english', ${query}), 32)
             + 0.5 * word_similarity(${query}, a.title) desc,
             a.updated_at desc) as rank
    from artifacts a
    left join artifact_versions v on v.id = a.current_version_id
    where a.workspace_id = ${auth.workspaceId}
      and a.archived_at is null
      and a.kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(",")}]::artifact_kind[]`)})
      and (
        to_tsvector('english', coalesce(v.plain_text, '')) @@ websearch_to_tsquery('english', ${query})
        or to_tsvector('english', a.title) @@ websearch_to_tsquery('english', ${query})
        or ${query} <% a.title
      )
    order by rank
    limit ${LEG_DEPTH}
  `);
  return (rows as unknown as KeywordRow[]).map((r) => ({ id: r.id, rank: Number(r.rank), title_match: Boolean(r.title_match) }));
}

async function meaningLeg(auth: AuthContext, vector: number[], model: string, kinds: readonly string[]): Promise<MeaningRow[]> {
  const literal = vectorLiteral(vector);
  const rows = await db.execute(sql`
    select c.owner_id as id, min(c.distance) as distance
    from (
      select e.owner_id, e.embedding <=> ${literal}::vector as distance
      from embeddings e
      where e.workspace_id = ${auth.workspaceId}
        and e.owner_type = 'artifact'
        and e.model = ${model}
      order by e.embedding <=> ${literal}::vector
      limit ${LEG_DEPTH * 3}
    ) c
    join artifacts a on a.id = c.owner_id
    where a.archived_at is null
      and a.kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(",")}]::artifact_kind[]`)})
      and c.distance <= ${MEANING_MAX_DISTANCE}
    group by c.owner_id
    order by distance
    limit ${LEG_DEPTH}
  `);
  return (rows as unknown as { id: string; distance: number | string }[]).map((r, i) => ({ id: r.id, rank: i + 1, distance: Number(r.distance) }));
}

export async function searchKnowledge(
  auth: AuthContext,
  input: { query: string; limit?: number; mode?: SearchMode; kinds?: readonly string[]; provider?: EmbeddingProvider },
): Promise<SearchResult> {
  const started = performance.now();
  const query = input.query.trim();
  const mode = input.mode ?? "hybrid";
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const kinds = input.kinds?.length ? input.kinds : SEARCH_KINDS;
  if (!query) return { hits: [], meaning: "off", ms: 0 };

  let meaningState: SearchResult["meaning"] = mode === "keyword" ? "off" : "ok";
  const meaningPromise: Promise<MeaningRow[]> =
    mode === "keyword"
      ? Promise.resolve([])
      : (async () => {
          let provider: EmbeddingProvider;
          try {
            provider = input.provider ?? embeddingProvider();
          } catch {
            meaningState = "unconfigured";
            return [];
          }
          try {
            const [vector] = await provider.embed([query]);
            return await meaningLeg(auth, vector, provider.model, kinds);
          } catch {
            meaningState = "failed";
            return [];
          }
        })();
  const [kw, mn] = await Promise.all([mode === "meaning" ? Promise.resolve([]) : keywordLeg(auth, query, kinds), meaningPromise]);

  const fused = fuse(kw, mn).slice(0, limit);
  if (!fused.length) return { hits: [], meaning: meaningState, ms: Math.round(performance.now() - started) };
  const ids = fused.map((f) => f.id);
  const meta = await db.execute(sql`
    select a.id, a.title, a.kind,
           coalesce(
             nullif(ts_headline('english', v.plain_text, websearch_to_tsquery('english', ${query}),
               'StartSel=[[, StopSel=]], MaxWords=24, MinWords=8, MaxFragments=1'), ''),
             left(v.plain_text, 160)) as snippet
    from artifacts a
    left join artifact_versions v on v.id = a.current_version_id
    where a.workspace_id = ${auth.workspaceId}
      and a.id = any(${sql.raw(`array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
  `);
  const byId = new Map((meta as unknown as { id: string; title: string; kind: string; snippet: string | null }[]).map((r) => [r.id, r]));
  const titleMatch = new Map(kw.map((r) => [r.id, r.title_match]));
  const hits = fused.flatMap((f): SearchHit[] => {
    const m = byId.get(f.id);
    if (!m) return [];
    return [{
      id: f.id,
      title: m.title,
      kind: m.kind,
      score: f.score,
      why: {
        keywordRank: f.kw,
        meaningRank: f.mn,
        similarity: f.distance == null ? null : 1 - f.distance,
        titleMatch: titleMatch.get(f.id) ?? false,
      },
      snippet: m.snippet?.replace(/\s+/g, " ").trim() || null,
    }];
  });
  return { hits, meaning: meaningState, ms: Math.round(performance.now() - started) };
}
