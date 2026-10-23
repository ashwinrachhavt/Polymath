import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { db } from "@/lib/db";
import { isYouTubeUrl } from "@/integrations/youtube/transcript";
import { documentExtractions, documents, youtubeTranscripts } from "./schema";

/*
 * Where a captured source is in the ingest pipeline, derived and never stored.
 * Six states, each read from a column that already exists:
 *
 *   queued      no extraction row, or a pending one nobody has claimed
 *   extracting  a pending row with a live lease
 *   embedding   text succeeded, no embeddedAt, no embedError
 *   ready       text succeeded and embedded
 *   failed      the latest extraction failed, or the embed pass did
 *   unsupported the bytes landed but no extractor accepts the type
 *
 * The projection uses the newest extraction by created_at, matching what
 * search.ts treats as current. It does not read the enum alone: a document can
 * have several extraction rows over its life.
 */

export type SourceReadiness = "queued" | "extracting" | "embedding" | "ready" | "failed" | "unsupported";

export type SourceRow = {
  documentId: string;
  title: string;
  /** Where it came from, and the one canonical address for a fetched source. */
  sourceUrl: string | null;
  kind: "document" | "video";
  readiness: SourceReadiness;
  /** Why it is not ready, when there is a reason worth showing. */
  detail: string | null;
  /** True when the source is a video whose timestamps can be cited. */
  hasTranscript: boolean;
  createdAt: Date;
  /** How long it has sat in `queued`, so a missing worker is visible. */
  queuedForMs: number | null;
};

const LIVE_LEASE_SECONDS = 600;

export async function listSources(auth: AuthContext, input: { limit?: number; documentIds?: string[] } = {}): Promise<SourceRow[]> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  if (input.documentIds && input.documentIds.length === 0) return [];

  const rows = await db
    .select({
      id: documents.id,
      title: documents.title,
      sourceUrl: documents.sourceUrl,
      fileId: documents.fileId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(and(
      eq(documents.workspaceId, auth.workspaceId),
      isNull(documents.archivedAt),
      input.documentIds ? inArray(documents.id, input.documentIds) : undefined,
    ))
    .orderBy(desc(documents.createdAt))
    .limit(limit);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.id);
  // One query for every document's newest extraction, not one per row.
  const extractions = await db
    .select({
      documentId: documentExtractions.documentId,
      status: documentExtractions.status,
      claimedAt: documentExtractions.claimedAt,
      createdAt: documentExtractions.createdAt,
      embeddedAt: documentExtractions.embeddedAt,
      embedError: documentExtractions.embedError,
      error: documentExtractions.error,
      extractor: documentExtractions.extractor,
      ageSeconds: sql<number>`extract(epoch from (now() - ${documentExtractions.createdAt}))::int`,
      claimAgeSeconds: sql<number | null>`extract(epoch from (now() - ${documentExtractions.claimedAt}))::int`,
    })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.workspaceId, auth.workspaceId), inArray(documentExtractions.documentId, ids)))
    .orderBy(desc(documentExtractions.createdAt));
  const latest = new Map<string, (typeof extractions)[number]>();
  for (const row of extractions) if (!latest.has(row.documentId)) latest.set(row.documentId, row);

  const transcripts = await db
    .select({ documentId: youtubeTranscripts.documentId, videoId: youtubeTranscripts.videoId })
    .from(youtubeTranscripts)
    .where(and(eq(youtubeTranscripts.workspaceId, auth.workspaceId), inArray(youtubeTranscripts.documentId, ids)));
  const videoIds = new Set(transcripts.map((t) => t.documentId));

  return rows.map((row) => {
    const extraction = latest.get(row.id) ?? null;
    const isVideo = videoIds.has(row.id) || (row.sourceUrl ? isYouTubeUrl(row.sourceUrl) : false);
    const { readiness, detail, queuedForMs } = project(extraction);
    // A fetch-class failure (the URL fetcher, the transcript fetcher) reads
    // "Couldn't fetch <title>" per DESIGN.md §8; the provider's reason rides
    // behind it as the secondary line. Other failures keep their reason.
    const isFetchFailure = readiness === "failed" && (extraction?.extractor === "url-fetch" || extraction?.extractor === "youtube-transcript");
    return {
      documentId: row.id,
      title: row.title,
      sourceUrl: row.sourceUrl,
      kind: isVideo ? "video" : "document",
      readiness,
      detail: isFetchFailure ? `Couldn't fetch ${row.title}. ${extraction?.error ?? ""}`.trim() : detail,
      hasTranscript: videoIds.has(row.id),
      createdAt: row.createdAt,
      queuedForMs,
    };
  });
}

function project(extraction: {
  status: string;
  claimedAt: Date | null;
  claimAgeSeconds: number | null;
  embeddedAt: Date | null;
  embedError: string | null;
  error: string | null;
  extractor: string | null;
  ageSeconds: number;
} | null): { readiness: SourceReadiness; detail: string | null; queuedForMs: number | null } {
  if (!extraction) {
    return { readiness: "queued", detail: "Waiting for the queue worker.", queuedForMs: null };
  }
  if (extraction.status === "failed") {
    return { readiness: "failed", detail: extraction.error ?? "The source could not be read.", queuedForMs: null };
  }
  if (extraction.status === "skipped") {
    return { readiness: "unsupported", detail: extraction.error ?? "No reader accepts this source type.", queuedForMs: null };
  }
  if (extraction.status === "pending") {
    const liveClaim = extraction.claimedAt !== null && (extraction.claimAgeSeconds ?? 0) < LIVE_LEASE_SECONDS;
    return liveClaim
      ? { readiness: "extracting", detail: "Reading the source.", queuedForMs: null }
      : { readiness: "queued", detail: extraction.ageSeconds > 120 ? "Waiting for the queue worker." : null, queuedForMs: extraction.ageSeconds * 1000 };
  }
  // succeeded
  if (extraction.embedError) {
    return { readiness: "failed", detail: extraction.embedError, queuedForMs: null };
  }
  if (!extraction.embeddedAt) {
    return { readiness: "embedding", detail: "Indexing for search.", queuedForMs: null };
  }
  return { readiness: "ready", detail: null, queuedForMs: null };
}

/** One document's readiness, for the notebook Sources pane. */
export async function sourceReadiness(auth: AuthContext, documentId: string): Promise<SourceRow | null> {
  const [row] = await listSources(auth, { limit: 1, documentIds: [documentId] });
  return row ?? null;
}
