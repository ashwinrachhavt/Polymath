import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { AuthContext } from "@/domains/identity/resolve";
import { auditEvents } from "@/domains/audit/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { escapeLike } from "@/lib/list-params";
import { currentExtractionIdSubquery } from "./versions";
import { mergeCandidates, type SectionCandidate } from "./zettel-merge";
import { ZETTEL_MERGE_MAX_PER_SOURCE, splitSections } from "./zettel-chunking";
import { defaultZettelExtractor, type ZettelExtractor } from "@/integrations/zettels/extractor";
import { generationProvider } from "@/integrations/generation/provider";
import {
  EmbeddingUnconfiguredError,
  embeddingProvider,
  type EmbeddingProvider,
} from "@/integrations/embeddings/provider";
import { embedArtifact, vectorLiteral } from "./embedding";
import {
  artifactLinks,
  artifactVersions,
  artifacts,
  claimEvidence,
  claims,
  concepts,
  documentExtractions,
  documents,
  sources,
  zettelProposals,
} from "./schema";

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

export const ZETTEL_MAX_PER_SOURCE = ZETTEL_MERGE_MAX_PER_SOURCE;
const MAX_TITLE = 120;
const MAX_CLAIM = 400;

/*
 * A candidate claim within this cosine distance of an accepted idea is its
 * twin. Calibrated far tighter than the related-neighbour threshold, so a
 * proposal is flagged only when accepting it would mint a near-duplicate.
 * Flags never auto-merge: the owner decides.
 */
export const ZETTEL_DUPLICATE_MAX_DISTANCE = 0.15;

export function isDuplicateDistance(distance: number): boolean {
  return distance <= ZETTEL_DUPLICATE_MAX_DISTANCE;
}

export type DuplicateHit = { artifactId: string; title: string; distance: number };

/**
 * The one accepted idea this claim would duplicate, nearest first, or null.
 * Embeds the claim with the provider (EmbeddingUnconfiguredError throws
 * through so a caller can degrade), then reads the corpus once. `conn`
 * lets the proposal pass run the lookup inside its own transaction.
 */
export async function findDuplicateIdea(
  auth: AuthContext,
  claim: string,
  options: { provider?: EmbeddingProvider; excludeArtifactId?: string; conn?: Pick<TxDrizzle, "execute"> } = {},
): Promise<DuplicateHit | null> {
  const provider = options.provider ?? embeddingProvider();
  const [vector] = await provider.embed([claim]);
  const conn = options.conn ?? db;
  const literal = vectorLiteral(vector);
  const result = await conn.execute(sql`
    select a.id, a.title, min(e.embedding <=> ${literal}::vector) as distance
    from embeddings e
    join artifacts a on a.id = e.owner_id
    where e.workspace_id = ${auth.workspaceId}
      and e.owner_type = 'artifact'
      and e.model = ${provider.model}
      and a.kind = 'zettel'
      and a.archived_at is null
      ${options.excludeArtifactId ? sql`and a.id <> ${options.excludeArtifactId}` : sql``}
    group by a.id, a.title
    having min(e.embedding <=> ${literal}::vector) <= ${ZETTEL_DUPLICATE_MAX_DISTANCE}
    order by distance asc
    limit 1
  `);
  const rows = result as unknown as Array<{ id: string; title: string; distance: number | string }>;
  const [hit] = rows;
  return hit ? { artifactId: hit.id, title: hit.title, distance: Number(hit.distance) } : null;
}

/** Same shape as obligationDedupeKey: kind, source, then what makes this one distinct (its span). */
export function zettelDedupeKey(prefix: "doc" | "artifact", sourceId: string, spanStart: number, spanEnd: number) {
  return `zettel:${prefix}:${sourceId}:${spanStart}-${spanEnd}`;
}

export type ZettelSourceInput =
  | { documentId: string; extractor?: ZettelExtractor; tx?: TxDrizzle }
  | { sourceArtifactId: string; extractor?: ZettelExtractor; tx?: TxDrizzle };

export type ResolvedZettelSource = {
  text: string;
  documentId: string | null;
  extractionId: string | null;
  sourceArtifactId: string | null;
  title: string;
};

/**
 * The text a proposal pass reads, from whichever source the input names. The
 * document branch is the succeeded-extraction lookup the per-document pass has
 * always used; the artifact branch reads the artifact's current version body,
 * so a conversation mined for ideas proposes against exactly what it shows.
 */
export async function resolveZettelSource(
  auth: AuthContext,
  input: ZettelSourceInput,
  conn: Pick<TxDrizzle, "select">,
): Promise<ResolvedZettelSource> {
  if ("sourceArtifactId" in input) {
    const [artifact] = await conn
      .select({ id: artifacts.id, title: artifacts.title, text: artifactVersions.plainText })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(and(eq(artifacts.id, input.sourceArtifactId), eq(artifacts.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!artifact?.text?.trim()) throw new Error("artifact has no readable text");
    return {
      text: artifact.text,
      documentId: null,
      extractionId: null,
      sourceArtifactId: artifact.id,
      title: artifact.title,
    };
  }

  // Ownership first, exactly as the per-document pass always reported it: a
  // document outside the workspace is "not found", whatever its extraction state.
  const [document] = await conn
    .select({ id: documents.id, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  if (!document) throw new Error("document not found in workspace");

  // Restores change what the document reads as, so proposals follow the pin.
  const [extraction] = await conn
    .select({ id: documentExtractions.id, text: documentExtractions.text })
    .from(documentExtractions)
    .innerJoin(documents, eq(documents.id, documentExtractions.documentId))
    .where(
      and(
        eq(documentExtractions.documentId, input.documentId),
        eq(documentExtractions.workspaceId, auth.workspaceId),
        eq(documentExtractions.status, "succeeded"),
        eq(documentExtractions.id, sql`(${currentExtractionIdSubquery()})`),
      ),
    )
    .limit(1);
  if (!extraction?.text) throw new Error("document has no succeeded extraction");
  return {
    text: extraction.text,
    documentId: document.id,
    extractionId: extraction.id,
    sourceArtifactId: null,
    title: document.title,
  };
}
/** Locate a quote in the text, tolerating only whitespace differences at the edges. */
function locate(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (q.length < 12) return null;
  const start = text.indexOf(q);
  return start === -1 ? null : { start, end: start + q.length };
}

/**
 * Which single origin a resolved source names. The plan's resolved-source
 * shape carries both ids as nullable, so the narrowing lives here instead of
 * a type assertion at the insert: a source naming neither is a bug and stops
 * the pass loudly.
 */
function zettelOrigin(source: ResolvedZettelSource): { path: "doc" | "artifact"; id: string } {
  if (source.documentId) return { path: "doc", id: source.documentId };
  if (source.sourceArtifactId) return { path: "artifact", id: source.sourceArtifactId };
  throw new Error("resolved source names neither a document nor an artifact");
}

/** What one proposal pass produced: the rows, and an honest read report. */
export type ZettelProposalResult = {
  proposals: Array<Awaited<ReturnType<typeof insertProposal>>>;
  readChars: number;
  unreadChars: number;
  unreadSections: number;
};

async function insertProposal(
  conn: Pick<TxDrizzle, "insert">,
  params: {
    auth: AuthContext;
    fromDocument: boolean;
    origin: { path: "doc" | "artifact"; id: string };
    extractionId: string | null;
    candidate: SectionCandidate;
    proposer: string;
    duplicateOfArtifactId: string | null;
  },
) {
  const { auth, fromDocument, origin, extractionId, candidate: z, proposer, duplicateOfArtifactId } = params;
  const [row] = await conn
    .insert(zettelProposals)
    .values({
      workspaceId: auth.workspaceId,
      ...(fromDocument ? { documentId: origin.id, extractionId } : { sourceArtifactId: origin.id }),
      title: z.title,
      claim: z.claim,
      quote: z.quote,
      spanStart: z.start,
      spanEnd: z.end,
      dedupeKey: zettelDedupeKey(origin.path, origin.id, z.start, z.end),
      proposer,
      duplicateOfArtifactId,
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing(
      fromDocument
        ? { target: [zettelProposals.documentId, zettelProposals.dedupeKey] }
        : {
            target: [zettelProposals.sourceArtifactId, zettelProposals.dedupeKey],
            where: sql`source_artifact_id is not null`,
          },
    )
    .returning();
  return row;
}

export async function proposeZettels(auth: AuthContext, input: ZettelSourceInput): Promise<ZettelProposalResult> {
  const conn = input.tx ?? db;
  const source = await resolveZettelSource(auth, input, conn);
  const origin = zettelOrigin(source);
  const fromDocument = origin.path === "doc";

  const extractor = input.extractor ?? defaultZettelExtractor(auth.workspaceId);

  // The source is read in bounded sections; a section is never truncated by
  // the extractor's input cap, and anything past the section cap is counted,
  // not dropped.
  const { sections, readChars, unreadChars, unreadSections } = splitSections(source.text);

  const survivors: SectionCandidate[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const candidates = await extractor.extract(section.text);
    for (const c of candidates) {
      const title = c.title?.trim();
      const claim = c.claim?.trim();
      if (!title || !claim || typeof c.quote !== "string") continue;
      // Located in the SECTION, then re-based onto the source, so the stored
      // span indexes the text the resolver read.
      const span = locate(section.text, c.quote);
      if (!span) continue; // not a verbatim passage: no evidence, no proposal
      survivors.push({
        title: title.slice(0, MAX_TITLE),
        claim: claim.slice(0, MAX_CLAIM),
        quote: c.quote.trim(),
        start: span.start + section.start,
        end: span.end + section.start,
        sectionIndex,
      });
    }
  }

  // One bounded merge over titles and claims only; quotes never reach the
  // model. It consolidates the candidates of a CHUNKED source; a source that
  // fit one section is the extractor's own single call, capped flat below.
  let merged = survivors;
  if (sections.length > 1 && survivors.length > 1) {
    merged = await mergeCandidates(survivors, { provider: generationProvider() });
  }

  const proposals = [];
  let dedupDegraded = false;
  for (const z of merged.slice(0, ZETTEL_MAX_PER_SOURCE)) {
    // Corpus-aware dedup flags twins; it decides nothing. Without an embedding
    // provider the pass degrades to unflagged proposals rather than failing —
    // a missing key must not block reading a document.
    let duplicateOfArtifactId: string | null = null;
    if (!dedupDegraded) {
      try {
        const hit = await findDuplicateIdea(auth, z.claim, { conn });
        duplicateOfArtifactId = hit?.artifactId ?? null;
      } catch (cause) {
        if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
        dedupDegraded = true;
        console.warn("[zettels] corpus dedup skipped: no embedding provider configured");
      }
    }
    const row = await insertProposal(conn, {
      auth,
      fromDocument,
      origin,
      extractionId: source.extractionId,
      candidate: z,
      proposer: extractor.name,
      duplicateOfArtifactId,
    });
    if (row) proposals.push(row);
  }
  return { proposals, readChars, unreadChars, unreadSections };
}

/** Proposals for one document with their duplicate flags and the pass's read report. */
export async function listZettelProposals(auth: AuthContext, documentId: string) {
  const flagged = alias(artifacts, "flagged_idea");
  const proposals = await db
    .select({
      proposal: zettelProposals,
      duplicateOf: { id: flagged.id, title: flagged.title },
    })
    .from(zettelProposals)
    .leftJoin(flagged, eq(flagged.id, zettelProposals.duplicateOfArtifactId))
    .where(and(eq(zettelProposals.documentId, documentId), eq(zettelProposals.workspaceId, auth.workspaceId)))
    .orderBy(zettelProposals.spanStart);
  // The read report travels with the audit row the pass wrote, so the review
  // page can say what was not read even after the proposal rows are settled.
  const [audit] = await db
    .select({ metadata: auditEvents.metadata })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, auth.workspaceId),
        eq(auditEvents.action, "capture.zettels_proposed"),
        sql`${auditEvents.metadata}->>'documentId' = ${documentId}`,
      ),
    )
    .orderBy(desc(auditEvents.createdAt))
    .limit(1);
  const counts = (audit?.metadata ?? {}) as { readChars?: number; unreadChars?: number; unreadSections?: number };
  return {
    proposals: proposals.map((row) => ({ ...row.proposal, duplicateOf: row.duplicateOf?.id ? row.duplicateOf : null })),
    readChars: counts.readChars ?? 0,
    unreadChars: counts.unreadChars ?? 0,
    unreadSections: counts.unreadSections ?? 0,
  };
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
      .where(
        and(
          eq(zettelProposals.id, input.proposalId),
          eq(zettelProposals.workspaceId, auth.workspaceId),
          eq(zettelProposals.status, "proposed"),
        ),
      )
      .returning();
    if (!proposal) throw new Error("zettel not found or already decided");
    /*
     * Provenance splits by source. A document-sourced proposal keeps the
     * extraction-span evidence it always had (a sources row and a
     * claim_evidence row). An artifact-sourced one has no extraction, so its
     * evidence is the verbatim quote carried on the card and its source edge
     * points at the artifact itself.
     */
    let sourceId: string | undefined;
    let sourceLabel: string;
    let edgeTargetType: "document" | "artifact";
    let edgeTargetId: string;
    if (proposal.documentId) {
      const [doc] = await tx
        .select({ fileId: documents.fileId, title: documents.title })
        .from(documents)
        .where(and(eq(documents.id, proposal.documentId), eq(documents.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!doc) throw new Error("document not found in workspace");
      sourceLabel = doc.title;
      edgeTargetType = "document";
      edgeTargetId = proposal.documentId;

      // The evidence points at a source row for the document's file; make it once.
      if (doc.fileId) {
        const [existing] = await tx
          .select({ id: sources.id })
          .from(sources)
          .where(
            and(
              eq(sources.workspaceId, auth.workspaceId),
              eq(sources.fileId, doc.fileId),
              eq(sources.kind, "document"),
            ),
          )
          .limit(1);
        sourceId = existing?.id;
      }
      if (!sourceId) {
        const [created] = await tx
          .insert(sources)
          .values({
            workspaceId: auth.workspaceId,
            kind: "document",
            title: doc.title,
            fileId: doc.fileId,
            createdBy: auth.userId,
            updatedBy: auth.userId,
          })
          .returning({ id: sources.id });
        sourceId = created.id;
      }
    } else if (proposal.sourceArtifactId) {
      const [sourceArtifact] = await tx
        .select({ title: artifacts.title })
        .from(artifacts)
        .where(and(eq(artifacts.id, proposal.sourceArtifactId), eq(artifacts.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!sourceArtifact) throw new Error("source artifact not found in workspace");
      sourceLabel = sourceArtifact.title;
      edgeTargetType = "artifact";
      edgeTargetId = proposal.sourceArtifactId;
    } else {
      throw new Error("proposal names no source");
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
      .where(
        and(
          eq(concepts.workspaceId, auth.workspaceId),
          eq(concepts.term, proposal.title),
          eq(concepts.sense, "domain"),
        ),
      )
      .limit(1);

    const [claim] = await tx
      .insert(claims)
      .values({
        workspaceId: auth.workspaceId,
        statement: proposal.claim,
        status: "accepted",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: claims.id });
    if (sourceId) {
      await tx.insert(claimEvidence).values({
        workspaceId: auth.workspaceId,
        claimId: claim.id,
        sourceId,
        extractionId: proposal.extractionId,
        quote: proposal.quote,
        startOffset: proposal.spanStart,
        endOffset: proposal.spanEnd,
      });
    }
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
    await tx
      .update(artifacts)
      .set({ currentVersionId: cardVersion.id, embedError: null })
      .where(eq(artifacts.id, card.id));
    await tx.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      targetType: edgeTargetType,
      targetId: edgeTargetId,
      linkType: "source",
      label: sourceLabel,
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
      metadata: {
        conceptId: concept.id,
        claimId: claim.id,
        documentId: proposal.documentId,
        sourceArtifactId: proposal.sourceArtifactId,
        artifactId: card.id,
      },
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
  /* §6/§14.12: the inert practice suggestion from metadata.bloom, when set. */
  bloom: { level: number; levelName: string } | null;
  /* §14.9: pending semantic suggestions for the in-strip accept/dismiss. */
  suggestedLinks: { targetId: string; targetTitle: string }[];
};

/*
 * The accepted zettel collection (ASH-184 views): cards read straight off the
 * artifact rows with their `source` edge joined in, so every view (cards,
 * table, timeline, dictionary) is a projection of the same store, never a
 * second one. Sorting belongs to the view — and belongs in the QUERY, not in
 * the component: the read is paginated, so sorting the returned page puts an
 * alphabetically earlier title on a later page and the list stops being in
 * the order it claims.
 */
export type ZettelSort = "recent" | "title";

export async function pageZettelCards(
  auth: AuthContext,
  input: { query?: string; tag?: string; limit: number; offset: number; sort?: ZettelSort },
): Promise<{ items: ZettelCardItem[]; total: number }> {
  return withTransaction(async (tx) => {
    const filters = [
      eq(artifacts.workspaceId, auth.workspaceId),
      eq(artifacts.kind, "zettel"),
      isNull(artifacts.archivedAt),
    ];
    if (input.tag?.trim())
      filters.push(sql`${artifacts.tags} @> ${JSON.stringify([input.tag.trim().toLowerCase()])}::jsonb`);
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
        metadata: artifacts.metadata,
        sourceDocumentId: artifactLinks.targetId,
        sourceTitle: artifactLinks.label,
      })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .leftJoin(
        artifactLinks,
        and(
          eq(artifactLinks.artifactId, artifacts.id),
          eq(artifactLinks.linkType, "source"),
          eq(artifactLinks.targetType, "document"),
        ),
      )
      .where(where)
      .orderBy(
        ...(input.sort === "title"
          ? [asc(artifacts.title), desc(artifacts.id)]
          : [desc(artifacts.updatedAt), desc(artifacts.id)]),
      )
      .limit(input.limit)
      .offset(input.offset);
    const [totalRow] = await tx
      .select({ n: count() })
      .from(artifacts)
      .leftJoin(artifactVersions, eq(artifactVersions.id, artifacts.currentVersionId))
      .where(where);
    // §14.9: the semantic suggestions still awaiting a decision on these
    // cards, for the metadata-strip accept/dismiss. Bounded per card.
    const suggestionRows = rows.length
      ? await tx
          .select({
            artifactId: artifactLinks.artifactId,
            targetId: artifactLinks.targetId,
            label: artifactLinks.label,
          })
          .from(artifactLinks)
          .where(
            and(
              eq(artifactLinks.workspaceId, auth.workspaceId),
              eq(artifactLinks.linkType, "semantic"),
              inArray(
                artifactLinks.artifactId,
                rows.map((r) => r.id),
              ),
            ),
          )
      : [];
    const suggestionsByCard = new Map<string, { targetId: string; targetTitle: string }[]>();
    for (const suggestion of suggestionRows) {
      const list = suggestionsByCard.get(suggestion.artifactId) ?? [];
      if (list.length < 3) list.push({ targetId: suggestion.targetId, targetTitle: suggestion.label ?? "Untitled" });
      suggestionsByCard.set(suggestion.artifactId, list);
    }
    return {
      total: totalRow?.n ?? 0,
      items: rows.map((row) => {
        const bloom = (row.metadata as { bloom?: { level?: unknown; levelName?: unknown } } | null)?.bloom;
        // Raw metadata stays server-side; only the bloom projection leaves.
        const { metadata: _metadata, ...rest } = row;
        return {
          ...rest,
          tags: Array.isArray(row.tags)
            ? (row.tags as unknown[]).filter((t): t is string => typeof t === "string")
            : [],
          excerpt: row.excerpt
            ? ((
                row.excerpt
                  .split("\n")
                  .map((l) => l.trim())
                  .find((l) => l.length > 0) ?? null
              )?.slice(0, 240) ?? null)
            : null,
          bloom:
            typeof bloom?.level === "number" && typeof bloom?.levelName === "string"
              ? { level: bloom.level, levelName: bloom.levelName }
              : null,
          suggestedLinks: suggestionsByCard.get(row.id) ?? [],
        };
      }),
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
    .where(
      and(
        eq(zettelProposals.id, input.proposalId),
        eq(zettelProposals.workspaceId, auth.workspaceId),
        eq(zettelProposals.status, "proposed"),
      ),
    )
    .returning();
  if (!row) throw new Error("zettel not found or already decided");
  return row;
}
