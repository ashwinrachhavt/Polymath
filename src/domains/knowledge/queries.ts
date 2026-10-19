import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { auditEvents } from "@/domains/audit/schema";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { escapeLike } from "@/lib/list-params";
import { companies, contacts } from "../crm/schema";
import {
  documentExtractions,
  documentObligations,
  documentParties,
  documents,
  fieldProposals,
  files,
  type documentPartyRole,
} from "./schema";

/*
 * Read queries for the document review surface. One composition point, so the
 * page never joins across domains itself: CRM name lookups by id are the only
 * cross-domain reads here, and they stay minimal by design.
 */

export type DocumentReviewParty = {
  id: string;
  partyRole: (typeof documentPartyRole.enumValues)[number];
  partyKind: "contact" | "company";
  displayName: string;
  resolutionStatus: string;
  /** CRM record it resolved to, with the name the UI shows. */
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
};

export type DocumentReview = {
  document: { id: string; title: string; mimeType: string | null; version: number; sourceUrl: string | null };
  extraction: {
    id: string;
    status: string;
    contentHash: string;
    error: string | null;
    proposalStatus: string | null;
    proposalError: string | null;
    proposer: string | null;
  } | null;
  /** Each proposal with the line of extracted text it was read from. */
  fieldProposals: Array<Awaited<ReturnType<typeof getFieldProposals>>[number] & { evidenceQuote: string | null }>;
  parties: DocumentReviewParty[];
  obligations: Awaited<ReturnType<typeof getDocumentObligations>>;
};

/** The document review surface: document + extraction + proposals + parties + obligations, in parallel. */
export async function getDocumentReview(
  auth: AuthContext,
  input: { documentId: string },
): Promise<DocumentReview | null> {
  const [doc] = await db
    .select({
      id: documents.id,
      title: documents.title,
      mimeType: documents.mimeType,
      version: documents.version,
      sourceUrl: documents.sourceUrl,
    })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!doc) return null;

  // Bounded parallel reads: each is a single indexed query scoped to the
  // document; none depends on another's result.
  const [extraction, fieldProposals, partyRows, obligationRows] = await Promise.all([
    db
      .select({
        id: documentExtractions.id,
        status: documentExtractions.status,
        contentHash: documentExtractions.contentHash,
        error: documentExtractions.error,
        proposalStatus: documentExtractions.proposalStatus,
        proposalError: documentExtractions.proposalError,
        proposer: documentExtractions.proposer,
        text: documentExtractions.text,
      })
      .from(documentExtractions)
      .where(eq(documentExtractions.documentId, input.documentId))
      .orderBy(desc(documentExtractions.createdAt))
      .limit(1),
    getFieldProposals(auth, input.documentId),
    db
      .select()
      .from(documentParties)
      .where(eq(documentParties.documentId, input.documentId))
      .orderBy(asc(documentParties.createdAt)),
    getDocumentObligations(auth, input.documentId),
  ]);

  // CRM name lookups by id — the minimal cross-domain read.
  const contactIds = partyRows.map((p) => p.contactId).filter((v): v is string => v !== null);
  const companyIds = partyRows.map((p) => p.companyId).filter((v): v is string => v !== null);
  const [contactRows, companyRows] = await Promise.all([
    contactIds.length
      ? db
          .select({ id: contacts.id, fullName: contacts.fullName })
          .from(contacts)
          .where(inArray(contacts.id, contactIds))
      : Promise.resolve([]),
    companyIds.length
      ? db
          .select({ id: companies.id, name: companies.name })
          .from(companies)
          .where(inArray(companies.id, companyIds))
      : Promise.resolve([]),
  ]);
  const contactName = new Map(contactRows.map((c) => [c.id, c.fullName]));
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));

  const latest = extraction[0] ?? null;
  return {
    document: doc,
    extraction: latest
      ? {
          id: latest.id,
          status: latest.status,
          contentHash: latest.contentHash,
          error: latest.error,
          proposalStatus: latest.proposalStatus,
          proposalError: latest.proposalError,
          proposer: latest.proposer,
        }
      : null,
    fieldProposals: fieldProposals.map((p) => ({
      ...p,
      evidenceQuote: p.extractionId === latest?.id ? evidenceLine(latest.text, p.evidenceSpans) : null,
    })),
    parties: partyRows.map((p) => ({
      id: p.id,
      partyRole: p.partyRole,
      partyKind: p.partyKind,
      displayName: p.displayName,
      resolutionStatus: p.resolutionStatus,
      contactId: p.contactId,
      contactName: p.contactId ? (contactName.get(p.contactId) ?? null) : null,
      companyId: p.companyId,
      companyName: p.companyId ? (companyName.get(p.companyId) ?? null) : null,
    })),
    obligations: obligationRows,
  };
}

/** The whole line around a proposal's first evidence span: what the owner checks the value against. */
function evidenceLine(text: string | null, spans: unknown): string | null {
  const span = Array.isArray(spans) ? (spans[0] as { start?: unknown; end?: unknown } | undefined) : undefined;
  if (!text || typeof span?.start !== "number" || typeof span.end !== "number" || span.end > text.length) return null;
  const from = text.lastIndexOf("\n", span.start - 1) + 1;
  const to = text.indexOf("\n", span.end);
  return text.slice(from, to === -1 ? undefined : to).trim().slice(0, 240);
}

/** Latest extraction's field proposals, oldest first — the review order. */
export async function getFieldProposals(auth: AuthContext, documentId: string) {
  return db
    .select({
      id: fieldProposals.id,
      fieldKind: fieldProposals.fieldKind,
      fieldName: fieldProposals.fieldName,
      rawValue: fieldProposals.rawValue,
      normalizedValue: fieldProposals.normalizedValue,
      normalizationNote: fieldProposals.normalizationNote,
      confidence: fieldProposals.confidence,
      status: fieldProposals.status,
      acceptedValue: fieldProposals.acceptedValue,
      dedupeKey: fieldProposals.dedupeKey,
      partyRole: fieldProposals.partyRole,
      extractionId: fieldProposals.extractionId,
      evidenceSpans: fieldProposals.evidenceSpans,
    })
    .from(fieldProposals)
    .where(
      and(eq(fieldProposals.documentId, documentId), eq(fieldProposals.workspaceId, auth.workspaceId)),
    )
    .orderBy(asc(fieldProposals.createdAt));
}

/** Obligations for the review surface, oldest first. */
export async function getDocumentObligations(auth: AuthContext, documentId: string) {
  return db
    .select({
      id: documentObligations.id,
      kind: documentObligations.kind,
      note: documentObligations.note,
      dueFromDocument: documentObligations.dueFromDocument,
      status: documentObligations.status,
      taskId: documentObligations.taskId,
    })
    .from(documentObligations)
    .where(
      and(
        eq(documentObligations.documentId, documentId),
        eq(documentObligations.workspaceId, auth.workspaceId),
      ),
    )
    .orderBy(asc(documentObligations.createdAt));
}

export type DocumentInboxRow = {
  id: string;
  title: string;
  filename: string | null;
  mimeType: string | null;
  createdAt: Date;
  /** A captured page keeps the address it came from; an uploaded file has none. */
  sourceUrl: string | null;
  /** What the row is: a fetched web page or an uploaded file. Derived, never stored. */
  kind: "web_page" | "file";
  /** When the page's bytes were last fetched and attached; null until the first fetch lands. */
  fetchedAt: Date | null;
  /** Latest extraction's status, or null when the document has not been read. */
  extractionStatus: string | null;
  /** That extraction's proposal-pass status; null when it has not run. */
  proposalStatus: string | null;
  /** Field proposals still awaiting a decision. */
  undecidedProposals: number;
  /** Resolved party names — the people and companies the document is about. */
  partyNames: string[];
};

/**
 * The inbox read: every unarchived document, its filename, its latest
 * extraction status, its undecided-proposal count, and its party names. Three
 * queries total (documents, undecided counts, party names), never one per row.
 */
export const INBOX_KINDS = ["file", "web_page"] as const;
export const INBOX_READ_STATES = ["unread", "failed"] as const;

export type DocumentInboxInput = {
  limit?: number;
  offset?: number;
  query?: string;
  kind?: (typeof INBOX_KINDS)[number];
  /** unread: never extracted. failed: the latest extraction failed. */
  readState?: (typeof INBOX_READ_STATES)[number];
};

function inboxWhere(auth: AuthContext, input: DocumentInboxInput): SQL {
  const parts: SQL[] = [eq(documents.workspaceId, auth.workspaceId), isNull(documents.archivedAt)];
  if (input.kind === "web_page") parts.push(isNotNull(documents.sourceUrl));
  if (input.kind === "file") parts.push(isNull(documents.sourceUrl));
  const latest = sql`(select de.status::text from document_extractions de where de.document_id = ${documents.id} order by de.created_at desc limit 1)`;
  if (input.readState === "unread") parts.push(sql`${latest} is null`);
  if (input.readState === "failed") parts.push(sql`${latest} = 'failed'`);
  if (input.query?.trim()) {
    const like = `%${escapeLike(input.query.trim())}%`;
    parts.push(or(ilike(documents.title, like), ilike(files.filename, like), ilike(documents.sourceUrl, like))!);
  }
  return and(...parts)!;
}

/** How many inbox documents match, for the pager. */
export async function countDocumentInbox(auth: AuthContext, input: DocumentInboxInput = {}): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(documents)
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(inboxWhere(auth, input));
  return row?.total ?? 0;
}

export async function getDocumentInbox(auth: AuthContext, limitOrInput: number | DocumentInboxInput = 50): Promise<DocumentInboxRow[]> {
  const input: DocumentInboxInput = typeof limitOrInput === "number" ? { limit: limitOrInput } : limitOrInput;
  const docRows = await db
    .select({
      id: documents.id,
      title: documents.title,
      filename: files.filename,
      mimeType: documents.mimeType,
      createdAt: documents.createdAt,
      sourceUrl: documents.sourceUrl,
      fetchedAt: files.createdAt,
      extractionStatus: sql<string | null>`(
        select de.status::text from document_extractions de
        where de.document_id = ${documents.id}
        order by de.created_at desc limit 1
      )`,
      proposalStatus: sql<string | null>`(
        select de.proposal_status::text from document_extractions de
        where de.document_id = ${documents.id}
        order by de.created_at desc limit 1
      )`,
    })
    .from(documents)
    .leftJoin(files, eq(files.id, documents.fileId))
    .where(inboxWhere(auth, input))
    .orderBy(desc(documents.createdAt), desc(documents.id))
    .limit(input.limit ?? 50)
    .offset(input.offset ?? 0);

  if (docRows.length === 0) return [];
  const documentIds = docRows.map((d) => d.id);

  const [proposalCounts, partyRows] = await Promise.all([
    db
      .select({ documentId: fieldProposals.documentId, undecided: count() })
      .from(fieldProposals)
      .where(
        and(
          inArray(fieldProposals.documentId, documentIds),
          eq(fieldProposals.workspaceId, auth.workspaceId),
          eq(fieldProposals.status, "proposed"),
        ),
      )
      .groupBy(fieldProposals.documentId),
    db
      .select({
        documentId: documentParties.documentId,
        displayName: documentParties.displayName,
        contactId: documentParties.contactId,
        companyId: documentParties.companyId,
      })
      .from(documentParties)
      .where(
        and(
          inArray(documentParties.documentId, documentIds),
          eq(documentParties.workspaceId, auth.workspaceId),
        ),
      ),
  ]);

  // Parties carry the extracted name until they resolve; the CRM record's name
  // replaces it once they do.
  const contactIds = partyRows.map((p) => p.contactId).filter((v): v is string => v !== null);
  const companyIds = partyRows.map((p) => p.companyId).filter((v): v is string => v !== null);
  const [contactRows, companyRows] = await Promise.all([
    contactIds.length
      ? db.select({ id: contacts.id, fullName: contacts.fullName }).from(contacts).where(inArray(contacts.id, contactIds))
      : Promise.resolve([]),
    companyIds.length
      ? db.select({ id: companies.id, name: companies.name }).from(companies).where(inArray(companies.id, companyIds))
      : Promise.resolve([]),
  ]);
  const contactName = new Map(contactRows.map((c) => [c.id, c.fullName]));
  const companyName = new Map(companyRows.map((c) => [c.id, c.name]));

  const undecidedBy = new Map(proposalCounts.map((c) => [c.documentId, Number(c.undecided)]));
  const namesBy = new Map<string, string[]>();
  for (const p of partyRows) {
    const name =
      (p.contactId ? contactName.get(p.contactId) : undefined) ??
      (p.companyId ? companyName.get(p.companyId) : undefined) ??
      p.displayName;
    const list = namesBy.get(p.documentId) ?? [];
    list.push(name);
    namesBy.set(p.documentId, list);
  }

  return docRows.map((d) => ({
    ...d,
    kind: d.sourceUrl ? ("web_page" as const) : ("file" as const),
    undecidedProposals: undecidedBy.get(d.id) ?? 0,
    partyNames: namesBy.get(d.id) ?? [],
  }));
}

/*
 * Assessment item D: "why this task exists". One accepted obligation can
 * create a canonical task; this reads the chain back - the obligation, its
 * document, the field proposal passage it rests on, and the decision rows
 * the audit kept. Read-only; the panel in the Work surface renders it.
 */
export async function getTaskProvenance(auth: AuthContext, taskId: string) {
  const rows = await db
    .select({
      obligationId: documentObligations.id,
      kind: documentObligations.kind,
      note: documentObligations.note,
      dueFromDocument: documentObligations.dueFromDocument,
      status: documentObligations.status,
      decidedAt: documentObligations.decidedAt,
      documentId: documents.id,
      documentTitle: documents.title,
      sourceUrl: documents.sourceUrl,
      fieldName: fieldProposals.fieldName,
      passage: fieldProposals.rawValue,
    })
    .from(documentObligations)
    .innerJoin(documents, eq(documents.id, documentObligations.documentId))
    .leftJoin(fieldProposals, eq(fieldProposals.id, documentObligations.fieldProposalId))
    .where(and(eq(documentObligations.workspaceId, auth.workspaceId), eq(documentObligations.taskId, taskId)))
    .orderBy(desc(documentObligations.decidedAt))
    .limit(10);

  if (!rows.length) return [];
  const audits = await db
    .select({
      subjectId: auditEvents.subjectId,
      action: auditEvents.action,
      summary: auditEvents.summary,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, auth.workspaceId),
        eq(auditEvents.subjectType, "document_obligation"),
        inArray(auditEvents.subjectId, rows.map((row) => row.obligationId)),
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(50);

  return rows.map((row) => ({
    ...row,
    history: audits.filter((event) => event.subjectId === row.obligationId),
  }));
}
