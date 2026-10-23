import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { embeddingProvider, type EmbeddingProvider } from "@/integrations/embeddings/provider";
import { EMBEDDING_OWNER_TYPE, vectorLiteral } from "./embedding";
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

export type DocumentSearchFilters = {
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
const likeContains = (s: string) =>
  `%${s.replace(/[\\%_]/g, "\\$&")}%`;

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
  const conditions = [
    eq(documents.workspaceId, auth.workspaceId),
    isNull(documents.archivedAt),
  ];

  const query = input.query?.trim();
  if (query) {
    const like = likeContains(query);
    conditions.push(
      or(
        textMatch(query),
        sql`${documents.title} ilike ${like}`,
        sql`${files.filename} ilike ${like}`,
      )!,
    );
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

  // One query, no joins that could duplicate a document with several extraction
  // versions: status comes from a correlated latest-extraction subquery.
  return db
    .select({
      id: documents.id,
      title: documents.title,
      snippet,
      filename: files.filename,
      extractionStatus: sql<string | null>`${currentExtractionSql("status")}`,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(and(...conditions))
    .orderBy(desc(documents.createdAt))
    .limit(limit)
    .offset(offset);
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
};

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
  const provider = input.provider ?? embeddingProvider();
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
      distance,
    })
    .from(embeddings)
    .innerJoin(documentExtractions, eq(documentExtractions.id, embeddings.ownerId))
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(
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
    ))
    .orderBy(distance)
    .limit(limit);

  return rows.map((r) => ({
    documentId: r.documentId,
    title: r.title,
    extractionId: r.extractionId,
    chunkIndex: r.chunkIndex,
    text: r.text,
    span: { start: r.start ?? 0, end: r.end ?? r.text.length, page: r.page },
    distance: Number(r.distance),
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
      rank,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documents.workspaceId, auth.workspaceId),
      isNull(documents.archivedAt),
      input.documentIds ? inArray(documents.id, input.documentIds) : undefined,
      eq(documentExtractions.status, "succeeded"),
      // Same current-version rule as searchChunks (versions.ts owns "current").
      sql`${documentExtractions.id}::text = ${currentExtractionSql("id")}`,
      sql`${tsVector} @@ ${tsQuery}`,
    ))
    .orderBy(desc(rank))
    .limit(limit);

  return rows.flatMap((r) => {
    const text = r.text ?? "";
    if (!text) return [];
    const { start, end } = passageWindow(text, query);
    return [{
      documentId: r.documentId,
      title: r.title,
      extractionId: r.extractionId,
      chunkIndex: 0,
      text: text.slice(start, end),
      span: { start, end, page: null },
      // ts_rank is higher-is-better; ChunkHit.distance is lower-is-closer.
      distance: 1 / (1 + Number(r.rank)),
    }];
  });
}

export const FTS_PASSAGE_RADIUS = 600;

/*
 * The passage an FTS hit returns: a window around the earliest query term
 * actually present in the extraction text (websearch matches on stems, so a
 * raw term may legitimately be absent - then the head of the document). The
 * offsets are real coordinates into the extraction text, the same contract as
 * embedding-chunk spans.
 */
export function passageWindow(text: string, query: string, radius = FTS_PASSAGE_RADIUS) {
  const terms = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
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
