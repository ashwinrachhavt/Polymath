import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { escapeLike } from "@/lib/list-params";
import { currentExtractionIdSubquery } from "./versions";
import { mergeCandidates, type SectionCandidate } from "./zettel-merge";
import { splitSections } from "./zettel-chunking";
import { capForSize } from "./zettel-capacity";
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
} from "./schema";

/*
 * Two zettelization paths share one extraction head.
 *
 * Direct creation (the authorship-is-acceptance pattern saveMessageAsIdea
 * established): the triggering action - a Zettelize click on the inbox, a
 * conversation save - is the permission, so `createZettelsFromSource` reads a
 * source and writes cards now, with no proposal row and no review step. The
 * card's content is the extractor's own words, of whatever length the idea
 * needs; the verbatim quote is the evidence block, located in the source
 * before anything is written.
 *
 * The extractor is injected. Whatever it returns is checked here against the
 * source: a quote that is not a verbatim passage of the text is dropped, so a
 * model cannot invent evidence.
 *
 * The card is an artifact of kind "zettel" - the same versioned container a
 * user-written note lives in, so a note and a zettel are the same kind of
 * thing in the link graph - with a `source` edge back to the document or
 * artifact it was made from. The concept, claim and evidence rows stay: the
 * card is the readable surface, they are the structured provenance underneath
 * it.
 */

const MAX_TITLE = 120;

/*
 * A candidate whose content sits within this cosine distance of an existing
 * idea is its twin. Calibrated far tighter than the related-neighbour
 * threshold. On the proposal path it flags the row for the owner to decide;
 * on the direct path it is a create-time gate - without a review step, a
 * duplicate card is pure noise, so the twin is skipped instead of minted.
 */
export const ZETTEL_DUPLICATE_MAX_DISTANCE = 0.15;

export function isDuplicateDistance(distance: number): boolean {
  return distance <= ZETTEL_DUPLICATE_MAX_DISTANCE;
}

type DuplicateHit = { artifactId: string; title: string; distance: number };

/**
 * The one existing idea this candidate's content would duplicate, nearest
 * first, or null. Embeds the content with the provider
 * (EmbeddingUnconfiguredError throws through so a caller can degrade), then
 * reads the corpus once. `conn` lets a pass run the lookup inside its own
 * transaction.
 */
async function findDuplicateIdea(
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

/**
 * The cards this source already produced, read off the edges: a card's
 * `source` link names the document or artifact it was made from, and its
 * claim row carries the content the repeat check compares. Cards created
 * before the claim's artifact pointer was written are invisible here; their
 * embeddings still catch them through the near-duplicate gate.
 */
async function listEarlierCards(
  auth: AuthContext,
  origin: { path: "doc" | "artifact"; id: string },
  conn: Pick<TxDrizzle, "select">,
) {
  return conn
    .select({ claim: claims.statement, quote: artifactLinks.context })
    .from(claims)
    .innerJoin(
      artifactLinks,
      and(
        eq(artifactLinks.artifactId, claims.artifactId),
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.linkType, "source"),
        eq(artifactLinks.targetType, origin.path === "doc" ? "document" : "artifact"),
        eq(artifactLinks.targetId, origin.id),
      ),
    );
}

/** Whitespace-collapsed form of a verbatim quote, for the containment check. */
function normalizedQuote(quote: string): string {
  return quote.replace(/\s+/g, " ").trim();
}

/**
 * True when either quote contains the other — the same passage read at
 * different widths. Every quote is a verbatim span of one source text, so
 * this is exact, and exact is what a re-chunked repeat needs: no model, no
 * threshold, just the passage itself.
 */
export function quotesOverlap(a: string, b: string): boolean {
  const left = normalizedQuote(a);
  const right = normalizedQuote(b);
  return left.length > 0 && right.length > 0 && (left.includes(right) || right.includes(left));
}

/** Cosine distance (1 − cosine similarity) between two equal-length vectors. */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 1 : 1 - dot / denom;
}

/** An earlier idea of this source: its content, its quote when it has one, and its embedded vector when one could be computed. */
type EarlierIdea = { claim: string; quote?: string; vector?: number[] };

/**
 * Whether a candidate repeats one of this source's earlier ideas. Quote
 * containment first (exact, free); then the content at the corpus distance
 * when the earlier ideas could be embedded. A hit proposes and creates
 * nothing — the earlier row already stands.
 */
async function isRepeatProposal(candidate: SectionCandidate, earlier: EarlierIdea[]): Promise<boolean> {
  if (candidate.quote && earlier.some((p) => p.quote && quotesOverlap(candidate.quote!, p.quote!))) return true;
  if (!earlier.some((p) => p.vector)) return false;
  const provider = embeddingProvider();
  const [vector] = await provider.embed([candidate.content]);
  return earlier.some((p) => p.vector && isDuplicateDistance(cosineDistance(vector, p.vector)));
}

export type ZettelSourceInput =
  | { documentId: string; extractor?: ZettelExtractor; tx?: TxDrizzle }
  | { sourceArtifactId: string; extractor?: ZettelExtractor; tx?: TxDrizzle };

type ResolvedZettelSource = {
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
async function resolveZettelSource(
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

/** What the shared extraction head resolved and produced, before any dedupe or write. */
type ZettelCandidatePass = {
  source: ResolvedZettelSource;
  origin: { path: "doc" | "artifact"; id: string };
  extractor: ZettelExtractor;
  cap: number;
  merged: SectionCandidate[];
  readChars: number;
  unreadChars: number;
  unreadSections: number;
};

/**
 * The extraction head both zettelization paths share: resolve the source,
 * read it in bounded sections, extract candidates, locate each quote in its
 * section (re-based onto the source), and merge the survivors of a chunked
 * source. No dedupe, no writes - the paths decide what a survivor becomes.
 */
async function zettelCandidatesForSource(auth: AuthContext, input: ZettelSourceInput): Promise<ZettelCandidatePass> {
  const conn = input.tx ?? db;
  const source = await resolveZettelSource(auth, input, conn);
  const origin = zettelOrigin(source);

  const extractor = input.extractor ?? defaultZettelExtractor(auth.workspaceId);

  // One size-derived cap for the whole pass, computed once from the resolved
  // source text: every seam below (extractor prompt, response schema, merge,
  // final slice) reads the same number. A ceiling only — zero candidates stays
  // an honest answer when the source makes no clear claims.
  const cap = capForSize(source.text.length);

  // The source is read in bounded sections; a section is never truncated by
  // the extractor's input cap, and anything past the section cap is counted,
  // not dropped.
  const { sections, readChars, unreadChars, unreadSections } = splitSections(source.text);

  const survivors: SectionCandidate[] = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const candidates = await extractor.extract(section.text, { max: cap });
    for (const c of candidates) {
      const title = c.title?.trim();
      const content = c.content?.trim();
      if (!title || !content) continue;
      const quote = typeof c.quote === "string" ? c.quote.trim() : undefined;
      let span: { start: number; end: number } | undefined;
      if (quote) {
        // Located in the SECTION, then re-based onto the source, so the
        // stored span indexes the text the resolver read. A quote that is
        // not a verbatim passage of its own section is invented evidence:
        // the candidate dies with it.
        const inSection = locate(section.text, quote);
        if (!inSection) continue;
        span = { start: inSection.start + section.start, end: inSection.end + section.start };
      }
      survivors.push({
        title: title.slice(0, MAX_TITLE),
        content,
        ...(quote && span ? { quote, ...span } : {}),
        sectionIndex,
      });
    }
  }

  // One bounded merge over titles and content only; quotes never reach the
  // model. It consolidates the candidates of a CHUNKED source; a source that
  // fit one section is the extractor's own single call, capped flat below.
  let merged = survivors;
  if (sections.length > 1 && survivors.length > 1) {
    merged = await mergeCandidates(survivors, { provider: generationProvider(), max: cap });
  }

  return { source, origin, extractor, cap, merged, readChars, unreadChars, unreadSections };
}

/** Embeds a source's earlier ideas with the corpus provider, degrading to quote-overlap alone when unconfigured. */
async function withEmbeddings(rows: { claim: string; quote?: string | null }[]): Promise<EarlierIdea[]> {
  if (!rows.length) return [];
  const normalized = rows.map((p) => ({ claim: p.claim, quote: p.quote ?? undefined }));
  try {
    const provider = embeddingProvider();
    const vectors = await provider.embed(normalized.map((p) => p.claim));
    return normalized.map((p, i) => ({ ...p, vector: vectors[i] }));
  } catch (cause) {
    if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
    console.warn("[zettels] earlier-idea dedup degraded: no embedding provider configured");
    return normalized;
  }
}

/*
 * Direct creation core (the authorship-is-acceptance pattern
 * saveMessageAsIdea established): the triggering action - a Zettelize click,
 * an enrichment stage, a tool call - is the permission, so the card is
 * written now and no proposal row waits for a second click.
 */

type ZettelCardSource = { kind: "document"; documentId: string } | { kind: "artifact"; artifactId: string };

export type ZettelCardCreateInput = {
  source: ZettelCardSource;
  /** Noun phrase, at most eight words - the extractor's title rule. */
  title: string;
  /** The idea, in the proposer's own words, of whatever length the idea needs. */
  content: string;
  /** Verbatim supporting passage. */
  quote?: string;
  /** Where the quote sits in the source text; seeds the span dedupe key and the evidence row. */
  span?: { start: number; end: number };
  /** The extraction the quote was located in, for the claim_evidence row. */
  extractionId?: string;
  /** The extractor's name - provenance, the same pattern proposals keep. */
  proposer: string;
  /** Merged into the zettel.created audit row. */
  auditMetadata?: Record<string, unknown>;
};

type ZettelCardCreated = { artifactId: string; conceptId: string; claimId: string };
export type ZettelCardCreateResult = ZettelCardCreated | { skipped: "duplicate" | "same-span" };

/**
 * Writes one zettel card from one candidate. Returns the card's ids, or a
 * skip reason when a gate declined: "same-span" (this exact span of this
 * source is already a card) or "duplicate" (a near-duplicate of an existing
 * card). Pass `tx` to ride an existing transaction - then the caller owns
 * the commit and with it the post-commit embed; without one the card gets
 * its own transaction and best-effort embedding.
 */
export async function createZettelFromSource(
  auth: AuthContext,
  input: ZettelCardCreateInput,
  tx?: TxDrizzle,
): Promise<ZettelCardCreateResult> {
  const create = async (conn: TxDrizzle): Promise<ZettelCardCreateResult> => {
    const origin =
      input.source.kind === "document"
        ? { path: "doc" as const, id: input.source.documentId }
        : { path: "artifact" as const, id: input.source.artifactId };
    const title = input.title.trim().slice(0, MAX_TITLE);
    const content = input.content.trim();
    const quote = input.quote?.trim();
    const dedupeKey = input.span ? zettelDedupeKey(origin.path, origin.id, input.span.start, input.span.end) : null;

    // Two create-time gates stand where the review queue used to. First:
    // the same span of the same source is already a card - a second click
    // lands on it instead of minting a twin.
    if (dedupeKey) {
      const [existing] = await conn
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(
          and(
            eq(artifacts.workspaceId, auth.workspaceId),
            eq(artifacts.kind, "zettel"),
            sql`${artifacts.metadata}->>'dedupeKey' = ${dedupeKey}`,
          ),
        )
        .limit(1);
      if (existing) return { skipped: "same-span" };
    }

    // Second: a near-duplicate of an existing card is skipped, not minted -
    // the review flow used to make that a human decision, and without one a
    // duplicate is pure noise. Without an embedding provider the gate
    // degrades to unfiltered creation rather than failing - a missing key
    // must not block reading a document.
    try {
      const hit = await findDuplicateIdea(auth, content, { conn });
      if (hit) return { skipped: "duplicate" };
    } catch (cause) {
      if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
      console.warn("[zettels] create-time dedup skipped: no embedding provider configured");
    }

    /*
     * Provenance splits by source. A document-sourced card keeps the
     * extraction-span evidence it always had (a sources row and a
     * claim_evidence row). An artifact-sourced one has no extraction, so its
     * evidence is the verbatim quote carried on the card and its source edge
     * points at the artifact itself.
     */
    let sourceId: string | undefined;
    let sourceLabel: string;
    let edgeTargetType: "document" | "artifact";
    let edgeTargetId: string;
    if (input.source.kind === "document") {
      const [doc] = await conn
        .select({ fileId: documents.fileId, title: documents.title })
        .from(documents)
        .where(and(eq(documents.id, input.source.documentId), eq(documents.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!doc) throw new Error("document not found in workspace");
      sourceLabel = doc.title;
      edgeTargetType = "document";
      edgeTargetId = input.source.documentId;

      // The evidence points at a source row for the document's file; make it once.
      if (doc.fileId) {
        const [existing] = await conn
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
        const [created] = await conn
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
    } else {
      const [sourceArtifact] = await conn
        .select({ title: artifacts.title })
        .from(artifacts)
        .where(and(eq(artifacts.id, input.source.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
        .limit(1);
      if (!sourceArtifact) throw new Error("source artifact not found in workspace");
      sourceLabel = sourceArtifact.title;
      edgeTargetType = "artifact";
      edgeTargetId = input.source.artifactId;
    }

    await conn
      .insert(concepts)
      .values({
        workspaceId: auth.workspaceId,
        term: title,
        sense: "domain",
        definition: content,
        sourceId,
        sourceQuote: quote,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .onConflictDoNothing({ target: [concepts.workspaceId, concepts.term, concepts.sense] });
    const [concept] = await conn
      .select({ id: concepts.id })
      .from(concepts)
      .where(and(eq(concepts.workspaceId, auth.workspaceId), eq(concepts.term, title), eq(concepts.sense, "domain")))
      .limit(1);

    // The zettel card: one artifact, version 1, carrying the idea as its
    // body (in as many paragraphs as it needs) and the verbatim quote as its
    // evidence block. [[Title]] links in the content resolve on the next
    // note-link sync like any note's.
    const paragraphs = content
      .split(/\n{2,}/)
      .filter((p) => p.length > 0)
      .map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }));
    const [card] = await conn
      .insert(artifacts)
      .values({
        workspaceId: auth.workspaceId,
        kind: "zettel",
        title,
        status: "reviewed",
        metadata: dedupeKey ? { dedupeKey } : null,
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: artifacts.id });
    const [cardVersion] = await conn
      .insert(artifactVersions)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: card.id,
        versionNumber: 1,
        content: {
          type: "doc",
          content: [
            ...paragraphs,
            ...(quote
              ? [{ type: "blockquote", content: [{ type: "paragraph", content: [{ type: "text", text: quote }] }] }]
              : []),
          ],
        },
        plainText: quote ? `${content}\n\n> ${quote}` : content,
        reason: "created",
        createdBy: auth.userId,
      })
      .returning({ id: artifactVersions.id });
    await conn
      .update(artifacts)
      .set({ currentVersionId: cardVersion.id, embedError: null })
      .where(eq(artifacts.id, card.id));

    const [claim] = await conn
      .insert(claims)
      .values({
        workspaceId: auth.workspaceId,
        artifactId: card.id,
        statement: content,
        status: "accepted",
        createdBy: auth.userId,
        updatedBy: auth.userId,
      })
      .returning({ id: claims.id });
    if (sourceId && quote && input.span) {
      await conn.insert(claimEvidence).values({
        workspaceId: auth.workspaceId,
        claimId: claim.id,
        sourceId,
        extractionId: input.extractionId,
        quote,
        startOffset: input.span.start,
        endOffset: input.span.end,
      });
    }
    await conn.insert(artifactLinks).values({
      workspaceId: auth.workspaceId,
      artifactId: card.id,
      targetType: edgeTargetType,
      targetId: edgeTargetId,
      linkType: "source",
      label: sourceLabel,
      context: quote,
    });

    /*
     * Sibling seeding: cards from the same source are joined the moment this
     * creation commits - durable `related` edges written inside this
     * transaction. Read off the `source` edges rather than any proposal
     * rows, so a card made by any surface (a document pass, a conversation
     * pass, a direct save) counts as a sibling. The semantic pass skips
     * explicitly-linked pairs, so these edges survive re-embeds; without
     * them, same-source cards stay strangers until an embedding pass happens
     * to find them similar.
     */
    const siblings = await conn
      .select({ artifactId: artifactLinks.artifactId, title: artifacts.title })
      .from(artifactLinks)
      .innerJoin(artifacts, eq(artifacts.id, artifactLinks.artifactId))
      .where(
        and(
          eq(artifactLinks.workspaceId, auth.workspaceId),
          eq(artifactLinks.linkType, "source"),
          eq(artifactLinks.targetType, edgeTargetType),
          eq(artifactLinks.targetId, edgeTargetId),
          ne(artifactLinks.artifactId, card.id),
        ),
      );
    const seenSiblings = new Set<string>();
    const distinct = siblings.filter((s) =>
      seenSiblings.has(s.artifactId) ? false : (seenSiblings.add(s.artifactId), true),
    );
    if (distinct.length > 0) {
      await conn.insert(artifactLinks).values(
        distinct.map((s) => ({
          workspaceId: auth.workspaceId,
          artifactId: card.id,
          targetType: "zettel",
          targetId: s.artifactId,
          linkType: "related",
          label: s.title,
          context: "From the same source",
        })),
      );
    }

    await recordAudit(
      auth,
      {
        action: "zettel.created",
        subjectType: "zettel",
        subjectId: card.id,
        summary: `Created zettel "${title}"`,
        metadata: {
          conceptId: concept.id,
          claimId: claim.id,
          documentId: origin.path === "doc" ? origin.id : null,
          sourceArtifactId: origin.path === "artifact" ? origin.id : null,
          artifactId: card.id,
          ...(dedupeKey ? { dedupeKey } : {}),
          ...input.auditMetadata,
        },
      },
      conn,
    );
    return { artifactId: card.id, conceptId: concept.id, claimId: claim.id };
  };

  if (tx) return create(tx);
  // Own transaction: the post-commit embed rides the accept pattern - the
  // new card joins the semantic graph best-effort, and a failed or
  // unconfigured embedding pass never blocks creation. A caller passing `tx`
  // owns the commit and with it the embeds.
  return withTransaction(create).then(async (value) => {
    if ("artifactId" in value) {
      try {
        await embedArtifact(auth, { artifactId: value.artifactId });
      } catch (cause) {
        console.error(
          `embedArtifact after zettel creation failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
    return value;
  });
}

/** What one direct-creation pass produced: the cards, the skips, and an honest read report. */
export type ZettelCardsResult = {
  created: Array<{ artifactId: string; title: string }>;
  skippedRepeats: number;
  skippedDuplicates: number;
  skippedSpans: number;
  readChars: number;
  unreadChars: number;
  unreadSections: number;
};

/**
 * The work half of direct zettelization: one resolved source in, cards out -
 * no proposal rows, no review step. One extraction head (sections, cap,
 * locate and merge seams) ends each surviving candidate in
 * createZettelFromSource, where the span and near-duplicate gates live. Pass
 * `tx` to run the whole pass in one transaction - then the caller owns the
 * commit and with it the post-commit embeds.
 */
export async function createZettelsFromSource(auth: AuthContext, input: ZettelSourceInput): Promise<ZettelCardsResult> {
  const conn = input.tx ?? db;
  const pass = await zettelCandidatesForSource(auth, input);

  // Re-zettelize dedup, both source kinds: the cards this source already
  // produced are judged before anything new is created.
  const earlier = await withEmbeddings(await listEarlierCards(auth, pass.origin, conn));

  const created: Array<{ artifactId: string; title: string }> = [];
  let skippedRepeats = 0;
  let skippedDuplicates = 0;
  let skippedSpans = 0;
  for (const z of pass.merged.slice(0, pass.cap)) {
    if (await isRepeatProposal(z, earlier)) {
      skippedRepeats += 1;
      continue;
    }
    const result = await createZettelFromSource(
      auth,
      {
        source:
          pass.origin.path === "doc"
            ? { kind: "document", documentId: pass.origin.id }
            : { kind: "artifact", artifactId: pass.origin.id },
        title: z.title,
        content: z.content,
        quote: z.quote,
        span: z.start !== undefined && z.end !== undefined ? { start: z.start, end: z.end } : undefined,
        extractionId: pass.source.extractionId ?? undefined,
        proposer: pass.extractor.name,
      },
      input.tx,
    );
    if ("skipped" in result) {
      if (result.skipped === "duplicate") skippedDuplicates += 1;
      else skippedSpans += 1;
      continue;
    }
    created.push({ artifactId: result.artifactId, title: z.title });
  }
  return {
    created,
    skippedRepeats,
    skippedDuplicates,
    skippedSpans,
    readChars: pass.readChars,
    unreadChars: pass.unreadChars,
    unreadSections: pass.unreadSections,
  };
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
        };
      }),
    };
  });
}

