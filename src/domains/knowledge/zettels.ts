import { and, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { escapeLike } from "@/lib/list-params";
import { currentExtractionIdSubquery } from "./versions";
import { defaultZettelExtractor, type ZettelCandidate, type ZettelExtractor } from "@/integrations/zettels/extractor";
import { embedArtifact } from "./embedding";
import { artifactLinks, artifactVersions, artifacts, claimEvidence, claims, concepts, documentExtractions, documents, sources, zettelProposals } from "./schema";

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
 *
 * Accept creates the zettel card itself (ASH-174/ASH-184): an artifact of kind
 * "zettel" - the same versioned container a user-written note lives in, so a
 * note and a zettel are the same kind of thing in the link graph - with a
 * `source` edge back to the document it was decomposed from. The concept,
 * claim and evidence rows stay: the card is the readable surface, they are the
 * structured provenance underneath it.
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

  // Restores change what the document reads as, so proposals follow the pin.
  const [extraction] = await db
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(and(
      eq(documentExtractions.documentId, input.documentId),
      eq(documentExtractions.workspaceId, auth.workspaceId),
      eq(documentExtractions.status, "succeeded"),
      eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
    ))
    .limit(1);
  if (!extraction?.text) throw new Error("document has no succeeded extraction");

  const extractor = input.extractor ?? defaultZettelExtractor(auth.workspaceId);
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
    // The zettel card: one artifact, version 1, carrying the claim as its
    // body and the verbatim quote as its evidence block. [[Title]] links in
    // the claim resolve on the next note-link sync like any note's.
    const zettelText = `${proposal.claim}\n\n> ${proposal.quote}`;
    const [card] = await tx
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "zettel",
        title: proposal.title,
        status: "reviewed",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [cardVersion] = await tx
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: card.id,
        versionNumber: 1,
        content: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: proposal.claim }] },
            { type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: proposal.quote }] }] },
          ],
        },
        plainText: zettelText,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await tx.update(artifacts).set({ currentVersionId: cardVersion.id, embedError: null }).where(eq(artifacts.id, card.id));
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      targetType: "document",
      targetId: proposal.documentId,
      linkType: "source",
      label: doc.title,
      context: proposal.quote,
    });
    await tx
      .update(zettelProposals)
      .set({ conceptId: concept.id, claimId: claim.id, artifactId: card.id })
      .where(eq(zettelProposals.id, proposal.id));
    await tx.insert(auditEvents).values({
      workspaceId: auth.workspaceId,
      actorId: auth.userId,
      actorKind: "user",
      action: "zettel.accepted",
      subjectType: "zettel_proposal",
      subjectId: proposal.id,
      summary: `Accepted zettel "${proposal.title}"`,
      metadata: { conceptId: concept.id, claimId: claim.id, documentId: proposal.documentId, artifactId: card.id },
    });
    return { conceptId: concept.id, claimId: claim.id, artifactId: card.id };
  }).then(async (value) => {
    // The new card joins the semantic graph best-effort; a failed or
    // unconfigured embedding pass never blocks an accept.
    try {
      await embedArtifact(auth, { artifactId: value.artifactId });
    } catch (cause) {
      console.error(`embedArtifact after accept failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    return value;
  });
}

export type ZettelCardItem = {
  id: string;
  title: string;
  tags: string[];
  excerpt: string | null;
  createdAt: Date;
  updatedAt: Date;
  sourceDocumentId: string | null;
  sourceTitle: string | null;
};

/*
 * The accepted zettel collection (ASH-184 views): cards read straight off the
 * artifact rows with their `source` edge joined in, so every view (cards,
 * table, timeline, dictionary) is a projection of the same store, never a
 * second one. Sorting belongs to the view; this read is newest-first.
 */
export async function pageZettelCards(
  auth: AuthContext,
  input: { query?: string; tag?: string; limit: number; offset: number },
): Promise<{ items: ZettelCardItem[]; total: number }> {
  return withTransaction(async (tx) => {
    const filters = [eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel"), isNull(artifacts.archivedAt)];
    if (input.tag?.trim()) filters.push(sql`${artifacts.tags} @> ${JSON.stringify([input.tag.trim().toLowerCase()])}::jsonb`);
    if (input.query?.trim()) {
      const like = `%${escapeLike(input.query.trim())}%`;
      filters.push(or(ilike(artifacts.title, like), ilike(artifactVersions.plainText, like))!);
    }
    const where = and(...filters);
    const rows = await tx
      .select({
        id: artifacts.id,
        title: artifacts.title,
        tags: artifacts.tags,
        excerpt: artifactVersions.plainText,
        createdAt: artifacts.createdAt,
        updatedAt: artifacts.updatedAt,
        sourceDocumentId: artifactLinks.targetId,
        sourceTitle: artifactLinks.label,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(
        artifactLinks,
        and(eq(artifactLinks.artifactId, artifacts.id), eq(artifactLinks.linkType, "source"), eq(artifactLinks.targetType, "document")),
      )
      .where(where)
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(input.limit)
      .offset(input.offset);
    const [totalRow] = await tx
      .select({ n: count() })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(where);
    return {
      total: totalRow?.n ?? 0,
      items: rows.map((row) => ({
        ...row,
        tags: Array.isArray(row.tags) ? (row.tags as unknown[]).filter((t): t is string => typeof t === "string") : [],
        excerpt: row.excerpt ? (row.excerpt.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? null)?.slice(0, 240) ?? null : null,
      })),
    };
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
