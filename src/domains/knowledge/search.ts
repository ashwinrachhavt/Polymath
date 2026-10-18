import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { documents, documentExtractions, files, reviewedAssertions } from "./schema";

/*
 * Document search: Postgres full-text over extraction text, with an ILIKE
 * fallback over filename and title so a document whose extraction failed is
 * still findable by name. Everything is OR-combined and workspace-scoped.
 *
 * No embeddings/pgvector here in v1 — semantic retrieval joins this module
 * later as a third branch of the same OR, not as a replacement.
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
      and to_tsvector('english', ${documentExtractions.text}) @@ plainto_tsquery('english', ${query})
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

  // One query, no joins that could duplicate a document with several extraction
  // versions: status comes from a correlated latest-extraction subquery.
  return db
    .select({
      id: documents.id,
      title: documents.title,
      filename: files.filename,
      extractionStatus: sql<string | null>`(
        select de.status::text from document_extractions de
        where de.document_id = ${documents.id}
        order by de.created_at desc limit 1
      )`,
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
