import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { auditEvents, blobObjects } from "@/domains/audit/schema";
import { companies, contacts } from "@/domains/crm/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import {
  documentClassificationProposals,
  documentDecisions,
  documentExtractionAttempts,
  documentExtractions,
  documentFolderEvents,
  documentFolders,
  documentObligations,
  documentParties,
  documents,
  documentRenameEvents,
  fieldProposals,
  files,
} from "./schema";
import { documentStatus, type DocumentStatus } from "./status";
import { getDocumentTags } from "./tags";
import { currentExtractionSql } from "./versions";

/*
 * The library read model for the Box-feel document manager (ASH-108 §13A,
 * ASH-127, ASH-130): one place the UI asks for folders, document pages,
 * document detail, versions and the activity feed. Cross-domain reads stay
 * minimal (CRM names by id), exactly like queries.ts.
 *
 * Pagination is keyset, not offset: a library that shifts under the cursor
 * (uploads land constantly) must not skip or repeat rows. The cursor is
 * opaque - the sort key value plus the id - and never trust-me parsed.
 *
 * The human state vocabulary is status.ts; the SQL filter below mirrors it,
 * and the integration suite asserts parity combination by combination.
 */

export type LibrarySort = "recent" | "added" | "title" | "size";
export const LIBRARY_SORTS: readonly LibrarySort[] = ["recent", "added", "title", "size"];

/** The status.ts labels, as filter values. The label text itself never leaves status.ts. */
export type LibraryStateFilter =
  | "added"
  | "reading"
  | "could_not_read"
  | "fields_not_read"
  | "fields_not_proposed"
  | "needs_check"
  | "filed";
export const LIBRARY_STATE_FILTERS: readonly LibraryStateFilter[] = [
  "added",
  "reading",
  "could_not_read",
  "fields_not_read",
  "fields_not_proposed",
  "needs_check",
  "filed",
];

export type LibraryFilters = {
  /** A folder id, or "root" for documents not filed anywhere. Omit for the whole library. */
  folder?: string;
  q?: string;
  docType?: string;
  state?: LibraryStateFilter;
  contactId?: string;
  companyId?: string;
  /** Documents carrying this tag. */
  tag?: string;
  /**
   * Documents that produced this task: an accepted obligation (document_obligations.task_id)
   * made it. Workspace-scoped through the obligation row, so another workspace's task id
   * matches nothing. Superseded obligations no longer count.
   */
  taskId?: string;
  createdFrom?: Date;
  createdTo?: Date;
};

export type LibraryPageInput = {
  filters?: LibraryFilters;
  sort?: LibrarySort;
  cursor?: string;
  limit?: number;
};

/*
 * The current extraction of a document, as a correlated subquery column.
 * "Current" is the restored version when one is pinned, else the newest row
 * (versions.ts owns the definition).
 */
const latestExtraction = (column: "status" | "proposal_status") =>
  sql<string | null>`${currentExtractionSql(column)}`;

const undecidedCount = sql<number>`(
  select count(*)::int from field_proposals fp
  where fp.document_id = ${documents.id} and fp.status = 'proposed'
)`;

/*
 * The inbox state of status.ts as one SQL expression. Keep the branch order
 * identical to documentStatus(): pending/skipped read as Reading, a failed
 * read is Could not read, then the proposal-pass ladder, then proposals
 * still undecided. The integration suite seeds every branch and asserts the
 * two stay equal.
 */
export const libraryStateSql = sql<string>`case
  when ${latestExtraction("status")} is null then 'added'
  when ${latestExtraction("status")} in ('pending', 'skipped') then 'reading'
  when ${latestExtraction("status")} = 'failed' then 'could_not_read'
  when ${latestExtraction("status")} = 'succeeded' and ${latestExtraction("proposal_status")} = 'failed' then 'fields_not_read'
  when ${latestExtraction("status")} = 'succeeded' and ${latestExtraction("proposal_status")} = 'pending' then 'reading'
  when ${latestExtraction("status")} = 'succeeded' and ${latestExtraction("proposal_status")} is distinct from 'succeeded' then 'fields_not_proposed'
  when ${latestExtraction("status")} = 'succeeded' and ${latestExtraction("proposal_status")} = 'succeeded' and ${undecidedCount} > 0 then 'needs_check'
  else 'filed'
end`;

/** The state key a row carries back to the UI, with the label and tone from status.ts - one vocabulary. */
export function libraryStateOf(key: string): DocumentStatus & { key: LibraryStateFilter } {
  switch (key) {
    case "added":
      return { key, ...documentStatus(null, 0) };
    case "reading":
      return { key, ...documentStatus({ status: "pending" }, 0) };
    case "could_not_read":
      return { key, ...documentStatus({ status: "failed" }, 0) };
    case "fields_not_read":
      return { key, ...documentStatus({ status: "succeeded", proposalStatus: "failed" }, 0) };
    case "fields_not_proposed":
      return { key, ...documentStatus({ status: "succeeded", proposalStatus: null }, 0) };
    case "needs_check":
      return { key, ...documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 1) };
    default:
      return { key: "filed", ...documentStatus({ status: "succeeded", proposalStatus: "succeeded" }, 0) };
  }
}

/* --- Cursor ---------------------------------------------------------------- */

type CursorPayload = { v: string | number; id: string };

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { v, id } = parsed as Record<string, unknown>;
    if (typeof id !== "string" || id.length === 0) return null;
    if (typeof v !== "string" && typeof v !== "number") return null;
    return { v, id };
  } catch {
    return null;
  }
}

/* --- Folders --------------------------------------------------------------- */

export type LibraryFolder = {
  id: string;
  parentId: string | null;
  name: string;
  /** Live documents filed directly in this folder. */
  documentCount: number;
  version: number;
};

/** Every live folder in the workspace with its direct document count; the tree is composed client-side. */
export async function listFolders(auth: AuthContext): Promise<LibraryFolder[]> {
  const rows = await db
    .select({
      id: documentFolders.id,
      parentId: documentFolders.parentId,
      name: documentFolders.name,
      version: documentFolders.version,
      documentCount: sql<number>`(
        select count(*)::int from documents d
        where d.folder_id = document_folders.id and d.archived_at is null
      )`,
    })
    .from(documentFolders)
    .where(and(eq(documentFolders.workspaceId, auth.workspaceId), isNull(documentFolders.archivedAt)))
    .orderBy(asc(sql`lower(${documentFolders.name})`));
  return rows;
}

/* --- Document pages --------------------------------------------------------- */

export type LibraryRow = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  docType: string | null;
  pageCount: number | null;
  sizeBytes: number | null;
  folderId: string | null;
  tags: string[];
  state: DocumentStatus & { key: LibraryStateFilter };
  undecidedProposals: number;
  /** The matching passage when the page came from a query; [[ ]] wraps the hit. */
  snippet: string | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
};

export type LibraryPage = {
  rows: LibraryRow[];
  /** Present when another page exists; pass it back as `cursor`. */
  nextCursor: string | null;
  /** How many documents match the filters, ignoring the cursor. */
  total: number;
};

function libraryWhere(auth: AuthContext, filters: LibraryFilters): SQL[] {
  const parts: SQL[] = [eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)];
  if (filters.folder === "root") parts.push(isNull(documents.folderId));
  else if (filters.folder) parts.push(eq(documents.folderId, filters.folder));
  if (filters.docType) parts.push(eq(documents.docType, filters.docType as never));
  if (filters.state) parts.push(eq(libraryStateSql, filters.state));
  if (filters.contactId) {
    parts.push(sql`exists (select 1 from document_parties dp where dp.document_id = ${documents.id} and dp.contact_id = ${filters.contactId})`);
  }
  if (filters.companyId) {
    parts.push(sql`exists (select 1 from document_parties dp where dp.document_id = ${documents.id} and dp.company_id = ${filters.companyId})`);
  }
  if (filters.tag) {
    parts.push(sql`exists (select 1 from document_tags dt where dt.document_id = ${documents.id} and dt.tag = ${filters.tag})`);
  }
  if (filters.taskId) {
    parts.push(
      sql`exists (select 1 from document_obligations dob where dob.document_id = ${documents.id} and dob.workspace_id = ${auth.workspaceId} and dob.task_id = ${filters.taskId} and dob.superseded_by is null)`,
    );
  }
  if (filters.createdFrom) parts.push(gte(documents.createdAt, filters.createdFrom));
  if (filters.createdTo) parts.push(lte(documents.createdAt, filters.createdTo));
  const q = filters.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    parts.push(
      or(
        sql`exists (
          select 1 from document_extractions de
          where de.document_id = ${documents.id}
            and to_tsvector('english', coalesce(de.text, '')) @@ plainto_tsquery('english', ${q})
        )`,
        ilike(documents.title, like),
        ilike(files.filename, like),
      )!,
    );
  }
  return parts;
}

/*
 * The keyset predicate for one sort: strictly past the cursor row. The whole
 * expression is parenthesized - drizzle's and() joins operands without
 * wrapping them, and an unwrapped "a or b" inside it swallows every other
 * filter (the folder, the workspace, the lot).
 */
function cursorWhere(sort: LibrarySort, cursor: CursorPayload): SQL {
  const { v, id } = cursor;
  switch (sort) {
    case "title": {
      const key = sql`lower(${documents.title})`;
      return sql`((${key} > ${String(v)}) or (${key} = ${String(v)} and ${documents.id} > ${id}))`;
    }
    case "size": {
      const key = sql`coalesce(${blobObjects.sizeBytes}, -1)`;
      return sql`((${key} < ${Number(v)}) or (${key} = ${Number(v)} and ${documents.id} < ${id}))`;
    }
    case "added": {
      const at = new Date(String(v));
      return sql`((${documents.createdAt} < ${at}) or (${documents.createdAt} = ${at} and ${documents.id} < ${id}))`;
    }
    default: {
      const at = new Date(String(v));
      return sql`((${documents.updatedAt} < ${at}) or (${documents.updatedAt} = ${at} and ${documents.id} < ${id}))`;
    }
  }
}

function orderByFor(sort: LibrarySort): SQL[] {
  switch (sort) {
    case "title":
      return [asc(sql`lower(${documents.title})`), asc(documents.id)];
    case "size":
      return [desc(sql`coalesce(${blobObjects.sizeBytes}, -1)`), desc(documents.id)];
    case "added":
      return [desc(documents.createdAt), desc(documents.id)];
    default:
      return [desc(documents.updatedAt), desc(documents.id)];
  }
}

function cursorOf(sort: LibrarySort, row: { id: string; title: string; sizeBytes: number | null; createdAt: Date; updatedAt: Date }): string {
  switch (sort) {
    case "title":
      return encodeCursor({ v: row.title.toLowerCase(), id: row.id });
    case "size":
      return encodeCursor({ v: row.sizeBytes ?? -1, id: row.id });
    case "added":
      return encodeCursor({ v: row.createdAt.toISOString(), id: row.id });
    default:
      return encodeCursor({ v: row.updatedAt.toISOString(), id: row.id });
  }
}

export const LIBRARY_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * One page of the library: filters in SQL, one page fetch, then the state
 * keys come from the same SQL expression the filter uses, so a filtered page
 * and its rows can never disagree about what "Needs your check" means.
 */
export async function listDocuments(auth: AuthContext, input: LibraryPageInput = {}): Promise<LibraryPage> {
  const filters = input.filters ?? {};
  const sort = input.sort ?? "recent";
  const limit = Math.min(Math.max(input.limit ?? LIBRARY_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const where = libraryWhere(auth, filters);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;

  const q = filters.q?.trim();
  const snippet = q
    ? sql<string | null>`(
        select ts_headline('english', de.text, plainto_tsquery('english', ${q}),
          'StartSel=[[, StopSel=]], MaxWords=24, MinWords=8, MaxFragments=1')
        from document_extractions de
        where de.document_id = ${documents.id} and de.status = 'succeeded'
          and de.id::text = ${currentExtractionSql("id")}
          and to_tsvector('english', coalesce(de.text, '')) @@ plainto_tsquery('english', ${q})
        limit 1
      )`
    : sql<string | null>`null`;

  const base = db
    .select({
      id: documents.id,
      title: documents.title,
      filename: files.filename,
      mimeType: documents.mimeType,
      docType: documents.docType,
      pageCount: documents.pageCount,
      sizeBytes: blobObjects.sizeBytes,
      folderId: documents.folderId,
      stateKey: libraryStateSql,
      undecidedProposals: undecidedCount,
      snippet,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      version: documents.version,
    })
    .from(documents)
    .leftJoin(files, eq(files.id, documents.fileId))
    .leftJoin(blobObjects, eq(blobObjects.id, files.blobId))
    .where(and(...where, cursor ? cursorWhere(sort, cursor) : undefined))
    .orderBy(...orderByFor(sort))
    .limit(limit + 1);

  const [rows, [totals]] = await Promise.all([
    base,
    db
      .select({ total: count() })
      .from(documents)
      .leftJoin(files, eq(files.id, documents.fileId))
      .leftJoin(blobObjects, eq(blobObjects.id, files.blobId))
      .where(and(...where)),
  ]);

  const page = rows.slice(0, limit);
  const tagsByDocument = await getDocumentTags(auth, page.map((row) => row.id));
  return {
    rows: page.map((row) => ({
      ...row,
      sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
      tags: tagsByDocument.get(row.id) ?? [],
      state: libraryStateOf(row.stateKey),
    })),
    nextCursor: rows.length > limit ? cursorOf(sort, page[page.length - 1]) : null,
    total: totals?.total ?? 0,
  };
}

/* --- Document detail, versions, activity ------------------------------------ */

export type DocumentVersionRow = {
  extractionId: string;
  contentHash: string;
  status: string;
  proposer: string | null;
  proposalStatus: string | null;
  createdAt: Date;
  error: string | null;
  /** True for the version the document currently reads as (the restore pin, else the newest). */
  isCurrent: boolean;
};

/** Every extraction version of a document, newest first - re-reading creates rows, never edits. */
export async function getDocumentVersions(auth: AuthContext, input: { documentId: string }): Promise<DocumentVersionRow[]> {
  const rows = await db
    .select({
      extractionId: documentExtractions.id,
      contentHash: documentExtractions.contentHash,
      status: documentExtractions.status,
      proposer: documentExtractions.proposer,
      proposalStatus: documentExtractions.proposalStatus,
      createdAt: documentExtractions.createdAt,
      error: documentExtractions.error,
      isCurrent: sql<boolean>`${documentExtractions.id}::text = ${currentExtractionSql("id")}`,
    })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(eq(documentExtractions.documentId, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(50);
  return rows;
}

export type DocumentActivityItem = {
  kind:
    | "added"
    | "extraction_attempt"
    | "classified"
    | "renamed"
    | "moved"
    | "field_decided"
    | "obligation_decided"
    | "decision"
    | "restored";
  at: Date;
  summary: string;
  /** Folder titles, old/new titles, error text - whatever the row honestly knows. */
  detail: Record<string, string | null>;
};

/**
 * The history of one document as a person reads it: what arrived, what was
 * read, what was proposed and decided, where it was filed. Composed from the
 * domain's own append-only tables (attempts, renames, folder events,
 * decisions) plus the mutable proposals' decision stamps - never from
 * reconstructed guesses. Bounded per source, merged newest first.
 */
export async function getDocumentActivity(
  auth: AuthContext,
  input: { documentId: string; limit?: number },
): Promise<DocumentActivityItem[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const [doc] = await db
    .select({ id: documents.id, createdAt: documents.createdAt, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return [];

  const [attempts, renames, moves, classifications, decisions, fieldRows, obligationRows, folderRows, restores] =
    await Promise.all([
      db
        .select({
          at: documentExtractionAttempts.startedAt,
          outcome: documentExtractionAttempts.outcome,
          error: documentExtractionAttempts.error,
          attempt: documentExtractionAttempts.attempt,
        })
        .from(documentExtractionAttempts)
        .innerJoin(documentExtractions, eq(documentExtractions.id, documentExtractionAttempts.extractionId))
        .where(and(eq(documentExtractions.documentId, doc.id), eq(documentExtractionAttempts.workspaceId, auth.workspaceId)))
        .orderBy(desc(documentExtractionAttempts.startedAt))
        .limit(limit),
      db
        .select({ at: documentRenameEvents.createdAt, oldTitle: documentRenameEvents.oldTitle, newTitle: documentRenameEvents.newTitle, source: documentRenameEvents.source })
        .from(documentRenameEvents)
        .where(and(eq(documentRenameEvents.documentId, doc.id), eq(documentRenameEvents.workspaceId, auth.workspaceId)))
        .orderBy(desc(documentRenameEvents.createdAt))
        .limit(limit),
      db
        .select({ at: documentFolderEvents.createdAt, fromFolderId: documentFolderEvents.fromFolderId, toFolderId: documentFolderEvents.toFolderId })
        .from(documentFolderEvents)
        .where(and(eq(documentFolderEvents.documentId, doc.id), eq(documentFolderEvents.workspaceId, auth.workspaceId)))
        .orderBy(desc(documentFolderEvents.createdAt))
        .limit(limit),
      db
        .select({ at: documentClassificationProposals.createdAt, decidedAt: documentClassificationProposals.decidedAt, status: documentClassificationProposals.status, proposedType: documentClassificationProposals.proposedType, proposer: documentClassificationProposals.proposer })
        .from(documentClassificationProposals)
        .where(and(eq(documentClassificationProposals.documentId, doc.id), eq(documentClassificationProposals.workspaceId, auth.workspaceId)))
        .orderBy(desc(documentClassificationProposals.createdAt))
        .limit(limit),
      db
        .select({ at: documentDecisions.decidedAt, decision: documentDecisions.decision })
        .from(documentDecisions)
        .where(and(eq(documentDecisions.documentId, doc.id), eq(documentDecisions.workspaceId, auth.workspaceId)))
        .orderBy(desc(documentDecisions.decidedAt))
        .limit(limit),
      db
        .select({ at: fieldProposals.decidedAt, status: fieldProposals.status, fieldName: fieldProposals.fieldName })
        .from(fieldProposals)
        .where(and(eq(fieldProposals.documentId, doc.id), eq(fieldProposals.workspaceId, auth.workspaceId), isNotNull(fieldProposals.decidedAt)))
        .orderBy(desc(fieldProposals.decidedAt))
        .limit(limit),
      db
        .select({ at: documentObligations.decidedAt, status: documentObligations.status, kind: documentObligations.kind })
        .from(documentObligations)
        .where(and(eq(documentObligations.documentId, doc.id), eq(documentObligations.workspaceId, auth.workspaceId), isNotNull(documentObligations.decidedAt)))
        .orderBy(desc(documentObligations.decidedAt))
        .limit(limit),
      db
        .select({ id: documentFolders.id, name: documentFolders.name })
        .from(documentFolders)
        .where(eq(documentFolders.workspaceId, auth.workspaceId)),
      db
        .select({ at: auditEvents.createdAt, payload: auditEvents.metadata })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, auth.workspaceId),
            eq(auditEvents.subjectType, "document"),
            eq(auditEvents.subjectId, doc.id),
            eq(auditEvents.action, "document.version_restored"),
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit),
    ]);

  const folderName = new Map(folderRows.map((f) => [f.id, f.name]));
  const items: DocumentActivityItem[] = [{ kind: "added", at: doc.createdAt, summary: "Added", detail: { title: doc.title } }];

  for (const a of attempts) {
    items.push({
      kind: "extraction_attempt",
      at: a.at,
      summary:
        a.outcome === "succeeded" ? `Read (attempt ${a.attempt})` : a.outcome === "failed" ? `Could not read (attempt ${a.attempt})` : `Reading abandoned (attempt ${a.attempt})`,
      detail: { error: a.error },
    });
  }
  for (const r of renames) {
    items.push({ kind: "renamed", at: r.at, summary: `Renamed to "${r.newTitle}"`, detail: { from: r.oldTitle, to: r.newTitle, source: r.source } });
  }
  for (const m of moves) {
    const to = m.toFolderId ? (folderName.get(m.toFolderId) ?? "a folder") : "the library root";
    const from = m.fromFolderId ? (folderName.get(m.fromFolderId) ?? "a folder") : "the library root";
    items.push({ kind: "moved", at: m.at, summary: `Moved from ${from} to ${to}`, detail: { from, to } });
  }
  for (const c of classifications) {
    if (c.status === "proposed") {
      items.push({ kind: "classified", at: c.at, summary: `Proposed type ${c.proposedType} (${c.proposer})`, detail: { status: c.status } });
    } else if (c.decidedAt) {
      items.push({ kind: "classified", at: c.decidedAt, summary: `Type ${c.proposedType} ${c.status}`, detail: { status: c.status } });
    }
  }
  for (const d of decisions) {
    items.push({ kind: "decision", at: d.at, summary: `Decision: ${d.decision}`, detail: {} });
  }
  for (const f of fieldRows) {
    if (f.at) items.push({ kind: "field_decided", at: f.at, summary: `Field ${f.fieldName} ${f.status}`, detail: { status: f.status } });
  }
  for (const o of obligationRows) {
    if (o.at) items.push({ kind: "obligation_decided", at: o.at, summary: `Obligation ${o.kind} ${o.status}`, detail: { status: o.status } });
  }

  for (const r of restores) {
    const payload = (r.payload ?? {}) as Record<string, unknown>;
    const hash = typeof payload.contentHash === "string" ? payload.contentHash.slice(0, 12) : null;
    items.push({ kind: "restored", at: r.at, summary: `Restored an earlier read${hash ? ` (${hash})` : ""}`, detail: { contentHash: hash } });
  }

  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
}

/* --- Party + folder lookups for the detail pane ----------------------------- */

/** The parties of one document with resolved CRM names - the preview pane's "who this concerns". */
export async function getDocumentParties(auth: AuthContext, input: { documentId: string }) {
  const rows = await db
    .select({
      id: documentParties.id,
      partyRole: documentParties.partyRole,
      displayName: documentParties.displayName,
      resolutionStatus: documentParties.resolutionStatus,
      contactId: documentParties.contactId,
      companyId: documentParties.companyId,
    })
    .from(documentParties)
    .innerJoin(documents, eq(documents.id, documentParties.documentId))
    .where(and(eq(documentParties.documentId, input.documentId), eq(documents.workspaceId, auth.workspaceId)));
  const contactIds = rows.map((p) => p.contactId).filter((v): v is string => v !== null);
  const companyIds = rows.map((p) => p.companyId).filter((v): v is string => v !== null);
  const [contactRows, companyRows] = await Promise.all([
    contactIds.length ? db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(inArray(contacts.id, contactIds)) : Promise.resolve([]),
    companyIds.length ? db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds)) : Promise.resolve([]),
  ]);
  const contactName = new Map(contactRows.map((c) => [c.id, c.fullName]));
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));
  return rows.map((p) => ({
    ...p,
    resolvedName: (p.contactId ? contactName.get(p.contactId) : undefined) ?? (p.companyId ? companyName.get(p.companyId) : undefined) ?? null,
  }));
}
