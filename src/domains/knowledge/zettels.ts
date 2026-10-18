import { and, desc, eq, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { openRouterZettelExtractor, type ZettelCandidate, type ZettelExtractor } from "@/integrations/zettels/extractor";
import { claimEvidence, claims, concepts, documentExtractions, documents, sources, zettelProposals } from "./schema";

/*
 * proposeZettels: one succeeded document in, proposal rows out. Each row is a
 * title, one claim, the verbatim passage it rests on (with its offsets into the
 * extraction text) and the document id. Nothing is knowledge until a human
 * accepts it. Accept writes the concept and the evidence link; reject writes
 * nothing but the decision.
 *
 * The extractor is injected. Whatever it returns is checked here against the
 * document: a quote that is not a verbatim passage of the extraction text is
 * dropped, so a model cannot invent evidence.
 */

export const MAX_ZETTELS_PER_DOCUMENT = 8;
const MAX_TITLE = 120;
const MAX_CLAIM = 400;

/** Same shape as obligationDedupeKey: kind, document, then what makes this one distinct (its span). */
export function zettelDedupeKey(documentId: string, spanStart: number, spanEnd: number) {
  return `zettel:${documentId}:${spanStart}-${spanEnd}`;
}

/** Locate a quote in the text, tolerating only whitespace differences at the edges. */
function locate(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (q.length < 12) return null;
  const start = text.indexOf(q);
  return start === -1 ? null : { start, end: start + q.length };
}

export async function proposeZettels(
  auth: AuthContext,
  input: { documentId: string; extractor?: ZettelExtractor },
) {
  const [document] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  const [extraction] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .where(and(
      eq(documentExtractions.documentId, input.documentId),
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documentExtractions.status, "succeeded"),
    ))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  if (!extraction?.text) throw new Error("document has no succeeded extraction");

  const extractor = input.extractor ?? openRouterZettelExtractor();
  const candidates = await extractor.extract(extraction.text);

  const accepted: Array<ZettelCandidate & { start: number; end: number }> = [];
  for (const c of candidates) {
    const title = c.title?.trim();
    const claim = c.claim?.trim();
    if (!title || !claim || typeof c.quote !== "string") continue;
    const span = locate(extraction.text, c.quote);
    if (!span) continue; // not a verbatim passage: no evidence, no proposal
    accepted.push({ title: title.slice(0, MAX_TITLE), claim: claim.slice(0, MAX_CLAIM), quote: c.quote.trim(), ...span });
    if (accepted.length >= MAX_ZETTELS_PER_DOCUMENT) break;
  }

  const created = [];
  for (const z of accepted) {
    const [row] = await db
      .insert(zettelProposals)
      .values({
        workspaceId: auth.workspaceId,
        documentId: input.documentId,
        extractionId: extraction.id,
        title: z.title,
        claim: z.claim,
        quote: z.quote,
        spanStart: z.start,
        spanEnd: z.end,
        dedupeKey: zettelDedupeKey(input.documentId, z.start, z.end),
        proposer: extractor.name,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [zettelProposals.documentId, zettelProposals.dedupeKey] })
      .returning();
    if (row) created.push(row);
  }
  return created;
}

/** Proposals for one document, oldest first, scoped to the workspace. */
export async function listZettelProposals(auth: AuthContext, documentId: string) {
  return db
    .select()
    .from(zettelProposals)
    .where(and(eq(zettelProposals.documentId, documentId), eq(zettelProposals.workspaceId, auth.workspaceId)))
    .orderBy(zettelProposals.spanStart);
}

/**
 * Accept: one transaction. The version-checked flip is the idempotency guard (a
 * second accept matches nothing). It then writes the concept (reusing an
 * existing one with the same term), a claim, and the claim_evidence row that
 * links the claim to the exact span of the source.
 */
export async function acceptZettel(auth: AuthContext, input: { proposalId: string }) {
  return withTransaction(async (tx) => {
    const [proposal] = await tx
      .update(zettelProposals)
      .set({
        status: "accepted",
        decidedAt: new Date(),
        decidedBy: auth.userId,
        updatedAt: new Date(),
        version: sql`${zettelProposals.version} + 1`,
      })
      .where(and(
        eq(zettelProposals.id, input.proposalId),
        eq(zettelProposals.workspaceId, auth.workspaceId),
        eq(zettelProposals.status, "proposed"),
      ))
      .returning();
    if (!proposal) throw new Error("zettel not found or already decided");

    const [doc] = await tx
      .select({ fileId: documents.fileId, title: documents.title })
      .from(documents)
      .where(and(eq(documents.id, proposal.documentId), eq(documents.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!doc) throw new Error("document not found in workspace");

    // The evidence points at a source row for the document's file; make it once.
    let sourceId: string | undefined;
    if (doc.fileId) {
      const [existing] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.workspaceId, auth.workspaceId), eq(sources.fileId, doc.fileId), eq(sources.kind, "document")))
        .limit(1);
      sourceId = existing?.id;
    }
    if (!sourceId) {
      const [created] = await tx
        .insert(sources)
        .values({ workspaceId: auth.workspaceId, kind: "document", title: doc.title, fileId: doc.fileId, createdBy: auth.userId, updatedBy: auth.userId })
        .returning({ id: sources.id });
      sourceId = created.id;
    }

    await tx
      .insert(concepts)
      .values({
        workspaceId: auth.workspaceId,
        term: proposal.title,
        sense: "domain",
        definition: proposal.claim,
        sourceId,
        sourceQuote: proposal.quote,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [concepts.workspaceId, concepts.term, concepts.sense] });
    const [concept] = await tx
      .select({ id: concepts.id })
      .from(concepts)
      .where(and(eq(concepts.workspaceId, auth.workspaceId), eq(concepts.term, proposal.title), eq(concepts.sense, "domain")))
      .limit(1);

    const [claim] = await tx
      .insert(claims)
      .values({ workspaceId: auth.workspaceId, statement: proposal.claim, status: "accepted", createdBy: auth.userId, updatedBy: auth.userId })
      .returning({ id: claims.id });
    await tx.insert(claimEvidence).values({
      workspaceId: auth.workspaceId,
      claimId: claim.id,
      sourceId,
      extractionId: proposal.extractionId,
      quote: proposal.quote,
      startOffset: proposal.spanStart,
      endOffset: proposal.spanEnd,
    });
    await tx
      .update(zettelProposals)
      .set({ conceptId: concept.id, claimId: claim.id })
      .where(eq(zettelProposals.id, proposal.id));
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "zettel.accepted",
      subjectType: "zettel_proposal",
      subjectId: proposal.id,
      summary: `Accepted zettel "${proposal.title}"`,
      metadata: { conceptId: concept.id, claimId: claim.id, documentId: proposal.documentId },
    });
    return { conceptId: concept.id, claimId: claim.id };
  });
}

/** Reject: records the decision and nothing else. No concept, claim or evidence row is written. */
export async function rejectZettel(auth: AuthContext, input: { proposalId: string }) {
  const [row] = await db
    .update(zettelProposals)
    .set({
      status: "rejected",
      decidedAt: new Date(),
      decidedBy: auth.userId,
      updatedAt: new Date(),
      version: sql`${zettelProposals.version} + 1`,
    })
    .where(and(
      eq(zettelProposals.id, input.proposalId),
      eq(zettelProposals.workspaceId, auth.workspaceId),
      eq(zettelProposals.status, "proposed"),
    ))
    .returning();
  if (!row) throw new Error("zettel not found or already decided");
  return row;
}
