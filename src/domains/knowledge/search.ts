import { resolveEmbedding } from "@/domains/billing/resolver";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import type { EmbeddingProvider } from "@/integrations/embeddings/provider";
import { EMBEDDING_OWNER_TYPE, vectorLiteral } from "./embedding";
import { chunkText } from "./chunking";
import { deriveCoverage, type EmbeddingCoverage } from "./coverage";
import { currentExtractionSql } from "./versions";
import { documents, documentExtractions, embeddings, files, reviewedAssertions } from "./schema";

/*
 * Document search: Postgres full-text over extraction text, with an ILIKE
 * fallback over filename and title so a document whose extraction failed is
 * still findable by name. Everything is OR-combined and workspace-scoped.
 *
 * Semantic retrieval is `searchChunks` below: the same workspace scope, over
 * the chunks the embedding pass wrote. It returns spans, not whole documents.
 */

type DocumentSearchFilters = {
  contactId?: string;
  companyId?: string;
  titleContains?: string;
  filenameContains?: string;
  createdFrom?: Date;
  createdTo?: Date;
};

export type DocumentSearchInput = {
  query?: string;
  filters?: DocumentSearchFilters;
  limit?: number;
  offset?: number;
};

/** Literal-substring LIKE pattern: the owner's `%` means a percent, not a wildcard. */
const likeContains = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

/** Any extraction row for this document whose text matches the query. */
const textMatch = (query: string): SQL =>
  sql`exists (
    select 1 from ${documentExtractions}
    where ${documentExtractions.documentId} = ${documents.id}
      and to_tsvector('english', coalesce(${documentExtractions.text}, '')) @@ plainto_tsquery('english', ${query})
  )`;

const partyMatch = (column: SQL): SQL =>
  sql`exists (select 1 from document_parties where document_parties.document_id = ${documents.id} and ${column})`;

export async function searchDocuments(auth: AuthContext, input: DocumentSearchInput = {}) {
  const conditions = [eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)];

  const query = input.query?.trim();
  if (query) {
    const like = likeContains(query);
    conditions.push(or(textMatch(query), sql`${documents.title} ilike ${like}`, sql`${files.filename} ilike ${like}`)!);
  }

  const f = input.filters ?? {};
  if (f.contactId) conditions.push(partyMatch(sql`contact_id = ${f.contactId}`));
  if (f.companyId) conditions.push(partyMatch(sql`company_id = ${f.companyId}`));
  if (f.titleContains) conditions.push(sql`${documents.title} ilike ${likeContains(f.titleContains)}`);
  if (f.filenameContains) conditions.push(sql`${files.filename} ilike ${likeContains(f.filenameContains)}`);
  if (f.createdFrom) conditions.push(gte(documents.createdAt, f.createdFrom));
  if (f.createdTo) conditions.push(lte(documents.createdAt, f.createdTo));

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
  const offset = Math.max(input.offset ?? 0, 0);

  // The evidence a hit is shown with: the matching passage of the latest
  // succeeded extraction, with matches wrapped in [[ ]] for the UI to mark.
  const snippet = query
    ? sql<string | null>`(
        select ts_headline('english', de.text, plainto_tsquery('english', ${query}),
          'StartSel=[[, StopSel=]], MaxWords=24, MinWords=8, MaxFragments=1')
        from document_extractions de
        where de.document_id = ${documents.id} and de.status = 'succeeded'
          and de.id::text = ${currentExtractionSql("id")}
          and to_tsvector('english', coalesce(de.text, '')) @@ plainto_tsquery('english', ${query})
        limit 1
      )`
    : sql<string | null>`null`;

  // Relevance when a query is present: the FTS rank of the document's CURRENT
  // extraction - the same extraction the snippet reads - so a document that
  // matches the query harder outranks a newer one that barely matches.
  // Title/filename-only fallback matches (no extraction hit) score 0 and fall
  // behind, newest first. Without a query nothing is rankable, so recency
  // answers alone.
  const rank = query
    ? sql<number>`coalesce((select ts_rank(to_tsvector('english', coalesce(de.text, '')), plainto_tsquery('english', ${query}))
        from document_extractions de
        where de.document_id = ${documents.id} and de.status = 'succeeded'
          and de.id::text = ${currentExtractionSql("id")}
          and to_tsvector('english', coalesce(de.text, '')) @@ plainto_tsquery('english', ${query})), 0)`
    : sql<number>`0`;

  // One query, no joins that could duplicate a document with several extraction
  // versions: status comes from a correlated latest-extraction subquery.
  return (
    db
      .select({
        id: documents.id,
        title: documents.title,
        snippet,
        filename: files.filename,
        extractionStatus: sql<string | null>`${currentExtractionSql("status")}`,
        createdAt: documents.createdAt,
        rank,
      })
      .from(documents)
      .leftJoin(files, eq(files.id, documents.fileId))
      .where(and(...conditions))
      // Relevance first, recency as the tiebreaker (see the rank note above). A
      // plain 0 cannot join ORDER BY - postgres reads an integer there as a
      // select-list ordinal - so without a query recency answers alone.
      .orderBy(...(query ? [desc(rank), desc(documents.createdAt)] : [desc(documents.createdAt)]))
      .limit(limit)
      .offset(offset)
  );
}

/*
 * Explain an assertion: which documents supplied this fact, in what order, and
 * what evidence did they cite. History includes superseded and retracted rows —
 * the question is "where did this belief come from", not "what is it now".
 */
export async function explainAssertion(
  auth: AuthContext,
  input: { subjectType: "contact" | "company" | "project" | "document"; subjectId: string; attribute: string },
) {
  const assertions = await db
    .select()
    .from(reviewedAssertions)
    .where(
      and(
        eq(reviewedAssertions.workspaceId, auth.workspaceId),
        eq(reviewedAssertions.subjectType, input.subjectType),
        eq(reviewedAssertions.subjectId, input.subjectId),
        eq(reviewedAssertions.attribute, input.attribute),
      ),
    )
    .orderBy(asc(reviewedAssertions.createdAt));

  // Two bounded queries, never one per row.
  const documentIds = [...new Set(assertions.map((a) => a.documentId).filter((id): id is string => id !== null))];
  const docs = documentIds.length
    ? await db
        .select({ id: documents.id, title: documents.title })
        .from(documents)
        .where(and(eq(documents.workspaceId, auth.workspaceId), inArray(documents.id, documentIds)))
    : [];
  const titleById = new Map(docs.map((d) => [d.id, d.title]));

  return assertions.map((a) => ({
    ...a,
    documentTitle: a.documentId ? (titleById.get(a.documentId) ?? null) : null,
  }));
}

export type ChunkHit = {
  documentId: string;
  title: string;
  extractionId: string;
  chunkIndex: number;
  /** The passage that matched. */
  text: string;
  /** Offsets into the extraction text, the same coordinates as extraction spans. */
  span: { start: number; end: number; page: number | null };
  /** Cosine distance: 0 is identical, 2 is opposite. Lower is closer. */
  distance: number;
  /** Derived embedding coverage of the cited extraction (issue #533 finding
   * 5): "partial" is PROVEN cap truncation, "complete" is PROVEN full
   * coverage, and everything the evidence cannot establish is "unknown" -
   * never a falsely reassuring "complete". See coverage.ts. */
  coverage?: EmbeddingCoverage;
};

/*
 * One bounded aggregate query derives coverage for a candidate set: chunk
 * count, index range and span range per (extraction, model), joined in code
 * against each extraction's recorded embedModel/embedError/text shape. No
 * N+1, no text transfer (lengths come from the queries that already fetch
 * the rows).
 */
async function coverageFor(
  extractions: {
    id: string;
    embedModel: string | null;
    embedError: string | null;
    textLength: number;
    leadingWhitespace: number;
  }[],
  workspaceId: string,
): Promise<Map<string, EmbeddingCoverage>> {
  const out = new Map<string, EmbeddingCoverage>();
  const unique = [...new Map(extractions.map((e) => [e.id, e])).values()];
  if (unique.length === 0) return out;
  const rows = await db
    .select({
      ownerId: embeddings.ownerId,
      model: embeddings.model,
      count: sql<number>`count(*)::int`,
      minIndex: sql<number | null>`min(${embeddings.chunkIndex})`,
      maxIndex: sql<number | null>`max(${embeddings.chunkIndex})`,
      minStart: sql<number | null>`min(${embeddings.spanStart})`,
      maxEnd: sql<number | null>`max(${embeddings.spanEnd})`,
    })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.workspaceId, workspaceId),
        eq(embeddings.ownerType, EMBEDDING_OWNER_TYPE),
        inArray(
          embeddings.ownerId,
          unique.map((e) => e.id),
        ),
      ),
    )
    .groupBy(embeddings.ownerId, embeddings.model);
  const byKey = new Map(rows.map((r) => [`${r.ownerId}${r.model}`, r]));
  for (const e of unique) {
    const agg = e.embedModel ? byKey.get(`${e.id}${e.embedModel}`) : undefined;
    out.set(
      e.id,
      deriveCoverage({
        embedModel: e.embedModel,
        embedError: e.embedError,
        textLength: e.textLength,
        leadingWhitespace: e.leadingWhitespace,
        chunks: {
          count: Number(agg?.count ?? 0),
          minIndex: agg?.minIndex == null ? null : Number(agg.minIndex),
          maxIndex: agg?.maxIndex == null ? null : Number(agg.maxIndex),
          minSpanStart: agg?.minStart == null ? null : Number(agg.minStart),
          maxSpanEnd: agg?.maxEnd == null ? null : Number(agg.maxEnd),
        },
      }),
    );
  }
  return out;
}

/** Trimmed length server-side: chunk spans index the untrimmed text, and trailing whitespace must not flip coverage to "partial". */
const trimmedTextLength = sql<number>`char_length(regexp_replace(coalesce(${documentExtractions.text}, ''), '\\s+$', ''))`;

/** Leading whitespace server-side: chunk 0 starts at the first non-blank, so coverage of the head is "first span start <= leading whitespace". */
const leadingWhitespace = sql<number>`char_length(coalesce(${documentExtractions.text}, '')) - char_length(regexp_replace(coalesce(${documentExtractions.text}, ''), '^\\s+', ''))`;

/*
 * Nearest chunks to a question, inside one workspace. Three scopes apply to
 * every row, so a chunk can only appear when all of them hold: the chunk
 * belongs to the workspace, its document belongs to the workspace, and its
 * extraction is the document's newest succeeded one (so a re-extracted
 * document never answers from stale text). Only chunks written by the same
 * model as the query vector are compared; vectors from different models are
 * not comparable.
 */
export async function searchChunks(
  auth: AuthContext,
  input: { query: string; limit?: number; provider?: EmbeddingProvider; documentIds?: string[] },
): Promise<ChunkHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  // An empty boundary (a dossier with no documents) matches nothing, never everything.
  if (input.documentIds && input.documentIds.length === 0) return [];
  const provider = input.provider ?? (await resolveEmbedding(auth.workspaceId));
  const [vector] = await provider.embed([query]);
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
  const distance = sql<number>`${embeddings.embedding} <=> ${vectorLiteral(vector)}::vector`;

  const rows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      extractionId: documentExtractions.id,
      chunkIndex: embeddings.chunkIndex,
      text: embeddings.content,
      start: embeddings.spanStart,
      end: embeddings.spanEnd,
      page: embeddings.page,
      embedModel: documentExtractions.embedModel,
      embedError: documentExtractions.embedError,
      textLength: trimmedTextLength,
      leadingWhitespace,
      distance,
    })
    .from(embeddings)
    .innerJoin(documentExtractions, eq(documentExtractions.id, embeddings.ownerId))
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(embeddings.workspaceId, auth.workspaceId),
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documents.workspaceId, auth.workspaceId),
        eq(embeddings.ownerType, EMBEDDING_OWNER_TYPE),
        eq(embeddings.model, provider.model),
        isNull(documents.archivedAt),
        input.documentIds ? inArray(documents.id, input.documentIds) : undefined,
        eq(documentExtractions.status, "succeeded"),
        // The current version answers; a restored older version answers, and a
        // superseded newer one stays silent (versions.ts owns "current").
        sql`${documentExtractions.id}::text = ${currentExtractionSql("id")}`,
      ),
    )
    .orderBy(distance)
    .limit(limit);

  const coverage = await coverageFor(
    rows.map((r) => ({
      id: r.extractionId,
      embedModel: r.embedModel,
      embedError: r.embedError,
      textLength: Number(r.textLength),
      leadingWhitespace: Number(r.leadingWhitespace),
    })),
    auth.workspaceId,
  );
  return rows.map((r) => ({
    documentId: r.documentId,
    title: r.title,
    extractionId: r.extractionId,
    chunkIndex: r.chunkIndex,
    text: r.text,
    span: { start: r.start ?? 0, end: r.end ?? r.text.length, page: r.page },
    distance: Number(r.distance),
    coverage: coverage.get(r.extractionId),
  }));
}

/*
 * Passage search without an embedding provider: Postgres full-text over each
 * document's current extraction text, under the same three scopes as
 * searchChunks (workspace on both tables, non-archived, current succeeded
 * version). This is the no-key path for the agent's documents.search: keyword
 * matching, not semantic similarity, and the caller labels the result that
 * way instead of failing closed when no embedding provider is configured.
 */
export async function searchChunksFts(
  auth: AuthContext,
  input: { query: string; limit?: number; documentIds?: string[] },
): Promise<ChunkHit[]> {
  const query = input.query.trim();
  if (!query) return [];
  // An empty boundary (a dossier with no documents) matches nothing, never everything.
  if (input.documentIds && input.documentIds.length === 0) return [];
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 50);
  // websearch_to_tsquery, never to_tsquery: model-written queries are
  // arbitrary prose and must not become syntax errors.
  const tsQuery = sql`websearch_to_tsquery('english', ${query})`;
  const tsVector = sql`to_tsvector('english', coalesce(${documentExtractions.text}, ''))`;
  const rank = sql<number>`ts_rank(${tsVector}, ${tsQuery})`;

  const rows = await db
    .select({
      documentId: documents.id,
      title: documents.title,
      extractionId: documentExtractions.id,
      text: documentExtractions.text,
      spans: documentExtractions.spans,
      embedModel: documentExtractions.embedModel,
      embedError: documentExtractions.embedError,
      rank,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documents.workspaceId, auth.workspaceId),
        isNull(documents.archivedAt),
        input.documentIds ? inArray(documents.id, input.documentIds) : undefined,
        eq(documentExtractions.status, "succeeded"),
        // Same current-version rule as searchChunks (versions.ts owns "current").
        sql`${documentExtractions.id}::text = ${currentExtractionSql("id")}`,
        sql`${tsVector} @@ ${tsQuery}`,
      ),
    )
    .orderBy(desc(rank))
    .limit(limit);

  /*
   * Canonical passage units (issue #533 finding 2). The FTS leg must speak
   * the SAME (extractionId, chunkIndex) identities the vector leg returns,
   * or fusion either collides unrelated windows or fails to align equivalent
   * evidence. Identity is established two ways, in order:
   *
   * 1. EXACT: when the embedding pass already wrote chunk rows for the
   *    extraction, reuse those rows verbatim (same text, span, page and
   *    chunkIndex). Nothing is recomputed, so no chunker drift can break
   *    identity for embedded documents. When several models embedded the
   *    extraction, the extraction's own embedModel wins - it names the
   *    latest successful pass.
   * 2. DETERMINISTIC: with no stored chunks (embedding not run, or failed)
   *    the extraction is re-chunked with the same pure chunker the embedding
   *    pass calls, on the same text and spans. chunkText is deterministic
   *    for a fixed input, and a determinism test locks its output so a
   *    chunker config change fails loudly instead of silently shifting
   *    identities. Lexical retrieval keeps working without any embedding.
   */
  const extractionIds = rows.map((r) => r.extractionId);
  const stored = extractionIds.length
    ? await db
        .select({
          ownerId: embeddings.ownerId,
          model: embeddings.model,
          chunkIndex: embeddings.chunkIndex,
          content: embeddings.content,
          spanStart: embeddings.spanStart,
          spanEnd: embeddings.spanEnd,
          page: embeddings.page,
        })
        .from(embeddings)
        .where(
          and(
            eq(embeddings.workspaceId, auth.workspaceId),
            eq(embeddings.ownerType, EMBEDDING_OWNER_TYPE),
            inArray(embeddings.ownerId, extractionIds),
          ),
        )
    : [];
  const storedByExtraction = new Map<string, typeof stored>();
  for (const row of stored) {
    const list = storedByExtraction.get(row.ownerId) ?? [];
    list.push(row);
    storedByExtraction.set(row.ownerId, list);
  }

  const coverage = await coverageFor(
    rows.map((r) => ({
      id: r.extractionId,
      embedModel: r.embedModel,
      embedError: r.embedError,
      textLength: (r.text ?? "").trimEnd().length,
      leadingWhitespace: (r.text ?? "").length - (r.text ?? "").trimStart().length,
    })),
    auth.workspaceId,
  );
  return rows.flatMap((r) => {
    const text = r.text ?? "";
    if (!text) return [];
    const cov = coverage.get(r.extractionId);
    const window = passageWindow(text, query);
    // ts_rank is higher-is-better; ChunkHit.distance is lower-is-closer.
    const distance = 1 / (1 + Number(r.rank));
    const storedChunks = storedByExtraction.get(r.extractionId);
    if (storedChunks && storedChunks.length > 0) {
      const preferred =
        r.embedModel && storedChunks.some((c) => c.model === r.embedModel)
          ? storedChunks.filter((c) => c.model === r.embedModel)
          : storedChunks;
      return preferred
        .filter((c) => (c.spanEnd ?? 0) > window.start && (c.spanStart ?? 0) < window.end)
        .map((c) => ({
          documentId: r.documentId,
          title: r.title,
          extractionId: r.extractionId,
          chunkIndex: c.chunkIndex,
          text: c.content,
          span: { start: c.spanStart ?? 0, end: c.spanEnd ?? c.content.length, page: c.page },
          distance,
          coverage: cov,
        }));
    }
    const spans = (r.spans ?? []) as { page: number; start: number; end: number }[];
    return chunkText(text, spans)
      .filter((c) => c.end > window.start && c.start < window.end)
      .map((chunk) => ({
        documentId: r.documentId,
        title: r.title,
        extractionId: r.extractionId,
        chunkIndex: chunk.index,
        text: chunk.text,
        span: { start: chunk.start, end: chunk.end, page: chunk.page },
        distance,
        coverage: cov,
      }));
  });
}

const FTS_PASSAGE_RADIUS = 600;

/*
 * The passage an FTS hit returns: a window around the earliest query term
 * actually present in the extraction text (websearch matches on stems, so a
 * raw term may legitimately be absent - then the head of the document). The
 * offsets are real coordinates into the extraction text, the same contract as
 * embedding-chunk spans.
 */
export function passageWindow(text: string, query: string, radius = FTS_PASSAGE_RADIUS) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const i = lower.indexOf(term);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return { start: 0, end: Math.min(text.length, radius * 2) };
  const start = Math.max(0, at - radius);
  return { start, end: Math.min(text.length, at + radius) };
}
