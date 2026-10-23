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

/*
 * Filter dimensions for search (spec: filter by kind, area, date or source).
 * - from/to bound artifacts.updated_at - the last EDIT, the same field the
 *   hit row shows. Rolling windows are computed by the caller; these are
 *   absolute instants, not calendar days, so timezone plays no role.
 * - provenance is generation provenance ONLY: produced_by_run_id set means a
 *   run generated the artifact ("agent"); null means no run produced it
 *   ("not-agent"). Null does NOT prove human authorship - imported material
 *   carries no run id either. It is not the spec's full "source" dimension
 *   (captured sources are not in this index at all; origin/channel provenance
 *   does not exist in the schema).
 * - areaTags is the area dimension's artifact linkage: an area is a name plus
 *   the note tags it covers (0241, declared never inferred), so an artifact
 *   is IN an area when it carries ANY of the area's declared tags. Callers
 *   resolve area -> tags against the areas table; tags are stored lowercased
 *   and this filter normalizes to lowercase too. The notes search resolves
 *   area names through area-resolve.ts (tenant-scoped, unavailable-never-
 *   broadens); the areas table (0241) is still file-only/unapplied to any
 *   shared database - this branch composes it for the consumer.
 */
export type SearchFilters = {
  from?: Date;
  to?: Date;
  provenance?: "agent" | "not-agent";
  areaTags?: string[];
};

/** One predicate set for every leg and count: a filter means the same thing everywhere. */
function filterSql(filters?: SearchFilters) {
  if (!filters) return sql``;
  // Area linkage: any declared tag matches (OR of jsonb contains, the same
  // binding pattern the notes list tag filter uses). Normalized here so no
  // caller can smuggle case/whitespace drift past the stored lowercase tags.
  const areaTags = [...new Set((filters.areaTags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0))];
  const area = areaTags.length
    ? sql` and (${sql.join(areaTags.map((t) => sql`a.tags @> ${JSON.stringify([t])}::jsonb`), sql` or `)})`
    : sql``;
  // postgres.js through db.execute cannot bind Date objects: send ISO strings.
  return sql`${filters.from ? sql` and a.updated_at >= ${filters.from.toISOString()}::timestamptz` : sql``}${filters.to ? sql` and a.updated_at < ${filters.to.toISOString()}::timestamptz` : sql``}${filters.provenance === "agent" ? sql` and a.produced_by_run_id is not null` : sql``}${filters.provenance === "not-agent" ? sql` and a.produced_by_run_id is null` : sql``}${area}`;
}

/** Kinds are interpolated into SQL as an enum array: only schema kinds may pass. */
function validKinds(kinds: readonly string[] | undefined): readonly string[] {
  const requested = kinds?.length ? kinds : SEARCH_KINDS;
  return requested.filter((k) => (SEARCH_KINDS as readonly string[]).includes(k));
}

export type SearchHit = {
  id: string;
  title: string;
  kind: string;
  /** The artifact's last edit - what the reader judges freshness against. */
  updatedAt: Date;
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

async function keywordLeg(auth: AuthContext, query: string, kinds: readonly string[], filters?: SearchFilters): Promise<KeywordRow[]> {
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
      and a.kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(",")}]::artifact_kind[]`)})${filterSql(filters)}
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

async function meaningLeg(auth: AuthContext, vector: number[], model: string, kinds: readonly string[], filters?: SearchFilters): Promise<MeaningRow[]> {
  const literal = vectorLiteral(vector);
  const rows = await db.execute(sql`
    select c.owner_id as id, min(c.distance) as distance
    from (
      select e.owner_id, e.embedding <=> ${literal}::vector as distance
      from embeddings e
      join artifacts a on a.id = e.owner_id
      where e.workspace_id = ${auth.workspaceId}
        and e.owner_type = 'artifact'
        and e.model = ${model}
        and e.source_version_id = a.current_version_id
      order by e.embedding <=> ${literal}::vector
      limit ${LEG_DEPTH * 3}
    ) c
    join artifacts a on a.id = c.owner_id
    where a.archived_at is null
      and a.kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(",")}]::artifact_kind[]`)})${filterSql(filters)}
      and c.distance <= ${MEANING_MAX_DISTANCE}
    group by c.owner_id
    order by distance
    limit ${LEG_DEPTH}
  `);
  return (rows as unknown as { id: string; distance: number | string }[]).map((r, i) => ({ id: r.id, rank: i + 1, distance: Number(r.distance) }));
}

/*
 * Query vectors are cached per process: the same query typed twice, or the
 * same prefix revisited while editing, costs one provider call, not two.
 */
const QUERY_CACHE_MAX = 200;
const queryCache = new Map<string, number[]>();
async function embedQuery(provider: EmbeddingProvider, query: string): Promise<number[]> {
  const key = `${provider.model}\u0000${query.toLowerCase()}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [vector] = await provider.embed([query]);
  if (queryCache.size >= QUERY_CACHE_MAX) queryCache.delete(queryCache.keys().next().value as string);
  queryCache.set(key, vector);
  return vector;
}

export async function searchKnowledge(
  auth: AuthContext,
  input: { query: string; limit?: number; mode?: SearchMode; kinds?: readonly string[]; filters?: SearchFilters; provider?: EmbeddingProvider },
): Promise<SearchResult> {
  const started = performance.now();
  const query = input.query.trim();
  const mode = input.mode ?? "hybrid";
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
  const kinds = validKinds(input.kinds);
  if (!query || !kinds.length) return { hits: [], meaning: "off", ms: 0 };

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
            const vector = await embedQuery(provider, query);
            return await meaningLeg(auth, vector, provider.model, kinds, input.filters);
          } catch {
            meaningState = "failed";
            return [];
          }
        })();
  const [kw, mn] = await Promise.all([mode === "meaning" ? Promise.resolve([]) : keywordLeg(auth, query, kinds, input.filters), meaningPromise]);

  const fused = fuse(kw, mn).slice(0, limit);
  if (!fused.length) return { hits: [], meaning: meaningState, ms: Math.round(performance.now() - started) };
  const ids = fused.map((f) => f.id);
  const meta = await db.execute(sql`
    select a.id, a.title, a.kind, extract(epoch from a.updated_at)::float8 as updated_at_epoch,
           coalesce(
             nullif(ts_headline('english', v.plain_text, websearch_to_tsquery('english', ${query}),
               'StartSel=[[, StopSel=]], MaxWords=24, MinWords=8, MaxFragments=1'), ''),
             left(v.plain_text, 160)) as snippet
    from artifacts a
    left join artifact_versions v on v.id = a.current_version_id
    where a.workspace_id = ${auth.workspaceId}
      and a.id = any(${sql.raw(`array[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`)})
  `);
  const byId = new Map(
    (meta as unknown as { id: string; title: string; kind: string; updated_at_epoch: number; snippet: string | null }[]).map((r) => [r.id, r]),
  );
  const titleMatch = new Map(kw.map((r) => [r.id, r.title_match]));
  const hits = fused.flatMap((f): SearchHit[] => {
    const m = byId.get(f.id);
    if (!m) return [];
    return [{
      id: f.id,
      title: m.title,
      kind: m.kind,
      updatedAt: new Date(m.updated_at_epoch * 1000),
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

/**
 * Partial-index visibility (spec: partial indexing is visible, never presented
 * as a complete search). Counts artifacts matching the SAME kinds, filters and
 * tenant scope as the search itself that the meaning leg CANNOT see: they have
 * current text but no embedding row for their current version - indexing
 * failed (embed_error set), is still pending, or the pass died before writing.
 * The meaning leg ranks only current-version chunks, so this count is exactly
 * "in scope, with text, not meaning-searchable". Empty-text artifacts are
 * excluded: embedArtifact skips them by design and there is nothing to index.
 */
export async function countMeaningUncovered(
  auth: AuthContext,
  input: { kinds?: readonly string[]; filters?: SearchFilters },
): Promise<number> {
  const kinds = validKinds(input.kinds);
  if (!kinds.length) return 0;
  const rows = await db.execute(sql`
    select count(*)::int as n
    from artifacts a
    join artifact_versions v on v.id = a.current_version_id
    where a.workspace_id = ${auth.workspaceId}
      and a.archived_at is null
      and length(trim(coalesce(v.plain_text, ''))) > 0
      and a.kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(",")}]::artifact_kind[]`)})${filterSql(input.filters)}
      and not exists (
        select 1 from embeddings e
        where e.workspace_id = ${auth.workspaceId}
          and e.owner_type = 'artifact'
          and e.owner_id = a.id
          and e.source_version_id = a.current_version_id
      )
  `);
  return (rows as unknown as Array<{ n: number }>)[0]?.n ?? 0;
}
