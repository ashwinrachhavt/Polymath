import { and, asc, count, desc, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { recordAudit } from "@/domains/audit/record";
import { learningArtifactFeedback } from "@/domains/learning/schema";
import { db } from "@/lib/db";
import { withTransaction, type TxDrizzle } from "@/lib/db-transaction";
import { escapeLike } from "@/lib/list-params";
import { currentExtractionIdSubquery } from "./versions";
import { mergeCandidates, type SectionCandidate } from "./zettel-merge";
import { splitSections } from "./zettel-chunking";
import { capForSize, ZETTEL_DUPLICATE_MAX_DISTANCE, ZETTEL_DUPLICATE_STRONG_DISTANCE } from "./zettel-capacity";
import { recordDisagreement } from "./tidy";
import { defaultZettelExtractor, type IdeaVerdict, type ZettelExtractor } from "@/integrations/zettels/extractor";
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
 * Extraction can create Zettels automatically, but generation is not user
 * acceptance. New cards are marked `generated`, and their claims remain
 * `proposed` until a person reviews them. The card's content is the
 * extractor's own words; its verbatim quote is relocated in the source
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

export { ZETTEL_DUPLICATE_MAX_DISTANCE };

export function isDuplicateDistance(distance: number): boolean {
  return distance <= ZETTEL_DUPLICATE_MAX_DISTANCE;
}

type DuplicateHit = { artifactId: string; title: string; content: string; distance: number };

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
    select a.id, a.title, coalesce(c.statement, av.plain_text) as content,
      min(e.embedding <=> ${literal}::vector) as distance
    from embeddings e
    join artifacts a on a.id = e.owner_id
    left join artifact_versions av on av.id = a.current_version_id
    left join claims c on c.artifact_id = a.id and c.workspace_id = a.workspace_id
      and c.status not in ('rejected', 'retracted')
    where e.workspace_id = ${auth.workspaceId}
      and e.owner_type = 'artifact'
      and e.model = ${provider.model}
      and a.kind = 'zettel'
      and a.archived_at is null
      ${options.excludeArtifactId ? sql`and a.id <> ${options.excludeArtifactId}` : sql``}
    group by a.id, a.title, c.statement, av.plain_text
    having min(e.embedding <=> ${literal}::vector) <= ${ZETTEL_DUPLICATE_MAX_DISTANCE}
    order by distance asc
    limit 1
  `);
  const rows = result as unknown as Array<{
    id: string;
    title: string;
    content: string | null;
    distance: number | string;
  }>;
  const [hit] = rows;
  return hit && hit.content
    ? { artifactId: hit.id, title: hit.title, content: hit.content, distance: Number(hit.distance) }
    : null;
}

async function linkSourceToExistingZettel(
  auth: AuthContext,
  zettelId: string,
  origin: { path: "doc" | "artifact"; id: string },
  quote: string | undefined,
  conn: TxDrizzle | typeof db,
): Promise<void> {
  const [target] = await conn
    .select({ title: artifacts.title })
    .from(artifacts)
    .where(and(eq(artifacts.id, zettelId), eq(artifacts.workspaceId, auth.workspaceId), eq(artifacts.kind, "zettel")))
    .limit(1);
  if (!target) throw new Error("Existing Zettel not found in workspace");

  const targetType = origin.path === "doc" ? "document" : "artifact";
  const [source] =
    origin.path === "doc"
      ? await conn
          .select({ title: documents.title })
          .from(documents)
          .where(and(eq(documents.id, origin.id), eq(documents.workspaceId, auth.workspaceId)))
          .limit(1)
      : await conn
          .select({ title: artifacts.title })
          .from(artifacts)
          .where(and(eq(artifacts.id, origin.id), eq(artifacts.workspaceId, auth.workspaceId)))
          .limit(1);
  if (!source) throw new Error("Zettel source not found in workspace");

  const [edge] = await conn
    .insert(artifactLinks)
    .values({
      workspaceId: auth.workspaceId,
      artifactId: zettelId,
      targetType,
      targetId: origin.id,
      linkType: "source",
      label: source.title,
      context: quote ?? null,
    })
    .onConflictDoNothing({ target: [artifactLinks.artifactId, artifactLinks.targetType, artifactLinks.targetId] })
    .returning({ id: artifactLinks.id });

  if (edge) {
    await recordAudit(
      auth,
      {
        action: "zettel.evidence_linked",
        subjectType: "zettel",
        subjectId: zettelId,
        summary: `Linked source "${source.title}" to zettel "${target.title}"`,
        metadata: { sourceType: targetType, sourceId: origin.id, ...(quote ? { quote } : {}) },
      },
      conn,
    );
  }
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
): Promise<EarlierIdea[]> {
  const rows = await conn
    .select({ artifactId: artifacts.id, title: artifacts.title, claim: claims.statement, quote: artifactLinks.context })
    .from(artifactLinks)
    .innerJoin(artifacts, and(eq(artifacts.id, artifactLinks.artifactId), eq(artifacts.workspaceId, auth.workspaceId)))
    .innerJoin(claims, and(eq(claims.artifactId, artifacts.id), eq(claims.workspaceId, auth.workspaceId)))
    .where(
      and(
        eq(artifactLinks.workspaceId, auth.workspaceId),
        eq(artifactLinks.linkType, "source"),
        eq(artifactLinks.targetType, origin.path === "doc" ? "document" : "artifact"),
        eq(artifactLinks.targetId, origin.id),
        eq(artifacts.kind, "zettel"),
        isNull(artifacts.archivedAt),
      ),
    )
    .limit(200);
  return rows.map(({ quote, ...row }) => ({ ...row, ...(quote ? { quote } : {}) }));
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
type EarlierIdea = { artifactId: string; title: string; claim: string; quote?: string };

/**
 * Whether a candidate repeats one of this source's earlier ideas. Quote
 * containment first (exact, free); then the content at the corpus distance
 * when the earlier ideas could be embedded. A hit proposes and creates
 * nothing — the earlier row already stands.
 */
function findQuoteOverlap(candidate: SectionCandidate, earlier: EarlierIdea[]): EarlierIdea | undefined {
  if (!candidate.quote) return undefined;
  return earlier.find((idea) => idea.quote && quotesOverlap(candidate.quote!, idea.quote));
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
type ZettelFeedbackExample = { rating: "helpful" | "not_helpful"; title: string; content: string };

async function recentZettelFeedback(auth: AuthContext): Promise<ZettelFeedbackExample[]> {
  const rows = await db
    .select({ rating: learningArtifactFeedback.rating, title: artifacts.title, content: artifactVersions.plainText })
    .from(learningArtifactFeedback)
    .innerJoin(
      artifacts,
      and(eq(artifacts.id, learningArtifactFeedback.artifactId), eq(artifacts.workspaceId, auth.workspaceId)),
    )
    .leftJoin(
      artifactVersions,
      and(eq(artifactVersions.id, artifacts.currentVersionId), eq(artifactVersions.workspaceId, auth.workspaceId)),
    )
    .where(
      and(
        eq(learningArtifactFeedback.workspaceId, auth.workspaceId),
        eq(learningArtifactFeedback.userId, auth.userId),
        eq(artifacts.kind, "zettel"),
        isNull(artifacts.archivedAt),
      ),
    )
    .orderBy(desc(learningArtifactFeedback.updatedAt), desc(learningArtifactFeedback.id))
    .limit(4);
  return rows.flatMap((row) =>
    row.content ? [{ rating: row.rating, title: row.title.slice(0, 120), content: row.content.slice(0, 200) }] : [],
  );
}

async function zettelCandidatesForSource(auth: AuthContext, input: ZettelSourceInput): Promise<ZettelCandidatePass> {
  const conn = input.tx ?? db;
  const source = await resolveZettelSource(auth, input, conn);
  const origin = zettelOrigin(source);

  const extractor = input.extractor ?? defaultZettelExtractor(auth.workspaceId);
  const feedback = await recentZettelFeedback(auth);

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
    const candidates = await extractor.extract(section.text, { max: cap, feedback });
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

/*
 * A generated Zettel is saved with `generated` status and a `proposed` claim.
 * Automatic persistence records a candidate; it does not imply the learner's approval.
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
 * True when a card for this exact source span already exists in the
 * workspace - the same-span gate's single question, shared by the batch pass
 * (which books the skip before the repeat heuristics) and by
 * createZettelFromSource (which re-asks for direct single-card callers).
 */
async function hasCardForSpan(auth: AuthContext, dedupeKey: string, conn: Pick<TxDrizzle, "select">) {
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
  return Boolean(existing);
}

/**
 * Writes one zettel card from one candidate. Returns the card's ids, or a
 * skip reason when a gate declined: "same-span" (this exact span of this
 * source is already a card) or "duplicate" (a near-duplicate of an existing
 * card). Pass `tx` to ride an existing transaction - then the caller owns
 * the commit and with it the post-commit embed; without one the card gets
 * its own transaction and best-effort embedding.
 */
/**
 * Persist one source-backed Zettel. Embedding and semantic comparison run
 * before opening the write transaction, so model latency never holds database
 * locks. The transaction still rechecks the exact source-span key.
 */

export async function createZettelFromSource(
  auth: AuthContext,
  input: ZettelCardCreateInput,
  tx?: TxDrizzle,
  options: {
    compareIdeas?: ZettelExtractor["compareIdeas"];
    excludeArtifactId?: string;
    /** A contradiction the caller already judged (the same-source repeat check), recorded once the card exists. */
    contradicts?: { artifactId: string; reason: string };
  } = {},
): Promise<ZettelCardCreateResult> {
  const origin =
    input.source.kind === "document"
      ? { path: "doc" as const, id: input.source.documentId }
      : { path: "artifact" as const, id: input.source.artifactId };
  const title = input.title.trim().slice(0, MAX_TITLE);
  const content = input.content.trim();
  const quote = input.quote?.trim();
  const dedupeKey = input.span ? zettelDedupeKey(origin.path, origin.id, input.span.start, input.span.end) : null;

  if (dedupeKey) {
    const [existing] = await db
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

  const contradictions = options.contradicts ? [options.contradicts] : [];
  try {
    const hit = await findDuplicateIdea(auth, content, { excludeArtifactId: options.excludeArtifactId });
    if (hit) {
      const verdict: IdeaVerdict =
        hit.distance <= ZETTEL_DUPLICATE_STRONG_DISTANCE || !options.compareIdeas
          ? { verdict: "same" }
          : await options.compareIdeas({
              candidate: { title, content, ...(quote ? { quote } : {}) },
              existing: { title: hit.title, content: hit.content },
            });
      if (verdict.verdict === "same") {
        if (tx) await linkSourceToExistingZettel(auth, hit.artifactId, origin, quote, tx);
        else await withTransaction((conn) => linkSourceToExistingZettel(auth, hit.artifactId, origin, quote, conn));
        return { skipped: "duplicate" };
      }
      if (verdict.verdict === "contradicts")
        contradictions.push({ artifactId: hit.artifactId, reason: verdict.reason });
    }
  } catch (cause) {
    if (!(cause instanceof EmbeddingUnconfiguredError)) throw cause;
    console.warn("[zettels] create-time dedup skipped: no embedding provider configured");
  }

  const create = async (conn: TxDrizzle): Promise<ZettelCardCreateResult> => {
    // The exact source-span gate is idempotent: retrying extraction for the
    // same source version cannot mint a second card for the same passage.
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
        status: "generated",
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
        status: "proposed",
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
    // A contradiction does not stop the card: both ideas stand, and the
    // disagreement becomes a finding for the person to settle.
    for (const contradiction of contradictions) {
      await recordDisagreement(conn, auth, {
        subjectId: card.id,
        otherId: contradiction.artifactId,
        reason: contradiction.reason,
      });
    }
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
  const earlier = await listEarlierCards(auth, pass.origin, conn);

  const created: Array<{ artifactId: string; title: string }> = [];
  let skippedRepeats = 0;
  let skippedDuplicates = 0;
  let skippedSpans = 0;
  for (const z of pass.merged.slice(0, pass.cap)) {
    // Exact source span is the cheapest and most reliable idempotency check.
    const span = z.start !== undefined && z.end !== undefined ? { start: z.start, end: z.end } : undefined;
    const dedupeKey = span ? zettelDedupeKey(pass.origin.path, pass.origin.id, span.start, span.end) : null;
    if (dedupeKey && (await hasCardForSpan(auth, dedupeKey, conn))) {
      skippedSpans += 1;
      continue;
    }

    let excludeArtifactId: string | undefined;
    let contradicts: { artifactId: string; reason: string } | undefined;
    const sourceRepeat = findQuoteOverlap(z, earlier);
    if (sourceRepeat) {
      const sameText = z.content.trim().toLocaleLowerCase() === sourceRepeat.claim.trim().toLocaleLowerCase();
      const verdict: IdeaVerdict =
        sameText || !pass.extractor.compareIdeas
          ? { verdict: "same" }
          : await pass.extractor.compareIdeas({
              candidate: { title: z.title, content: z.content, ...(z.quote ? { quote: z.quote } : {}) },
              existing: { title: sourceRepeat.title, content: sourceRepeat.claim },
            });
      if (verdict.verdict === "same") {
        await linkSourceToExistingZettel(auth, sourceRepeat.artifactId, pass.origin, z.quote, conn);
        skippedRepeats += 1;
        continue;
      }
      excludeArtifactId = sourceRepeat.artifactId;
      if (verdict.verdict === "contradicts")
        contradicts = { artifactId: sourceRepeat.artifactId, reason: verdict.reason };
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
        span,
        extractionId: pass.source.extractionId ?? undefined,
        proposer: pass.extractor.name,
      },
      input.tx,
      { compareIdeas: pass.extractor.compareIdeas, excludeArtifactId, contradicts },
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
