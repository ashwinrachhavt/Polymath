import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { companies, contacts } from "../crm/schema";
import {
  documentExtractions,
  documentObligations,
  documentParties,
  documents,
  fieldProposals,
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
  document: { id: string; title: string; mimeType: string | null };
  extraction: {
    id: string;
    status: string;
    contentHash: string;
    error: string | null;
  } | null;
  fieldProposals: Awaited<ReturnType<typeof getFieldProposals>>;
  parties: DocumentReviewParty[];
  obligations: Awaited<ReturnType<typeof getDocumentObligations>>;
};

/** The document review surface: document + extraction + proposals + parties + obligations, in parallel. */
export async function getDocumentReview(
  auth: AuthContext,
  input: { documentId: string },
): Promise<DocumentReview | null> {
  const [doc] = await db
    .select({ id: documents.id, title: documents.title, mimeType: documents.mimeType })
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

  return {
    document: doc,
    extraction: extraction[0] ?? null,
    fieldProposals,
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
      dueKind: documentObligations.dueKind,
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
