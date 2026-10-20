import { and, desc, eq } from "drizzle-orm";
import type { AuthContext } from "@/domains/identity/resolve";
import { workspaceOwnerAuth } from "@/domains/audit/outbox-handlers";
import type { ClaimedOutboxEvent, OutboxHandler } from "@/domains/audit/outbox";
import { OutboxParkError } from "@/domains/audit/outbox";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { fetchTranscript, type FetchLike, type TranscriptCue, type TranscriptResult } from "@/integrations/youtube/transcript";
import { extractDocument } from "./extraction";
import { DocumentAlreadyHasFileError, intakeFile } from "./intake";
import { captureUrl } from "./capture-url";
import { documentExtractions, documents, sources, youtubeTranscripts } from "./schema";
import { recordSource } from "./sources";
import { YOUTUBE_TOPIC } from "./youtube-capture";

/*
 * The YouTube consumer (NotebookLM parity, S1). Three things happen here, in
 * this order, each idempotent on redelivery:
 *
 *   1. fetch the timed text (the only provider call)
 *   2. file the text as the document's bytes and record the source identity
 *   3. write the cue table so a citation can deep-link to ?t=<seconds>
 *
 * The normal extraction pass then runs on the text, because the text is a
 * plain-text file. Timestamps never enter extraction spans: those are character
 * offsets, and a video's seconds are a different coordinate space.
 *
 * A video with no captions is a recorded failure, not an empty document. The
 * document row already exists (written when the capture was queued), so the
 * failure lands on an extraction row and the source stays retryable.
 */

const PROVIDER_DOWN = (cause: unknown) => cause instanceof TypeError;

export const youtubeTranscriptRequestedHandler: OutboxHandler = async (event: ClaimedOutboxEvent) => {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`youtube.transcript_requested has a malformed payload (${typeof raw}); redeploy the producer`);
  }
  const payload = raw as { documentId?: unknown; videoId?: unknown; sourceUrl?: unknown };
  const documentId = typeof payload.documentId === "string" ? payload.documentId : null;
  if (!documentId) throw new Error("youtube.transcript_requested has no documentId");
  const sourceUrl = typeof payload.sourceUrl === "string" ? payload.sourceUrl : `https://www.youtube.com/watch?v=${payload.videoId ?? ""}`;

  const [doc] = await db
    .select({ id: documents.id, fileId: documents.fileId, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, event.workspaceId)))
    .limit(1);
  if (!doc) return; // The document was deleted; nothing to file.
  // Already fetched on a previous delivery: the extraction pass was queued then.
  if (doc.fileId) return;

  const auth = await workspaceOwnerAuth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to receive the transcript");

  let result: TranscriptResult;
  try {
    result = await fetchTranscript(sourceUrl, { fetchImpl: (globalThis.fetch as unknown as FetchLike) });
  } catch (cause) {
    if (PROVIDER_DOWN(cause)) throw new OutboxParkError(60_000, "YouTube is unreachable");
    throw cause;
  }

  if (!result.ok) {
    await recordTranscriptFailure(auth, documentId, result.error);
    // A stated failure is terminal: retrying a video with no captions cannot
    // succeed, so this is a completed attempt with a recorded reason.
    return;
  }

  const bytes = new TextEncoder().encode(result.text);
  const contentHash = await sha256Hex(bytes);
  try {
    await intakeFile(auth, {
      bytes,
      filename: `${result.videoId}.txt`,
      title: result.title ?? doc.title,
      verdict: { ok: true, mimeType: "text/plain" },
      contentHash,
      origin: "youtube",
      sourceUrl: result.canonicalUrl,
      documentId,
      // A video source is a document source: dossiers.sourceFor matches kind
      // "document", and a "video" kind would mint a second sources row for the
      // same file.
      inTransaction: (tx) =>
        recordSource(auth, tx, {
          title: result.title ?? doc.title,
          url: result.canonicalUrl,
          contentHash,
          kind: "document",
        }),
    });
  } catch (cause) {
    // A concurrent delivery filed the same bytes; that is the success case.
    if (cause instanceof DocumentAlreadyHasFileError) return;
    throw cause;
  }

  await writeCues(auth, { documentId, videoId: result.videoId, cues: result.cues, language: result.language, generated: result.generated });
  // The text is durable; extraction and embedding follow through their own path.
  await extractDocument(auth, { documentId });
};

/** The cue table is replaced, not appended: one document has one transcript. */
async function writeCues(
  auth: AuthContext,
  input: { documentId: string; videoId: string; cues: TranscriptCue[]; language: string | null; generated: boolean },
) {
  const [latest] = await db
    .select({ id: documentExtractions.id })
    .from(documentExtractions)
    .where(and(eq(documentExtractions.documentId, input.documentId), eq(documentExtractions.workspaceId, auth.workspaceId)))
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);

  await withTransaction(async (tx) => {
    await tx
      .insert(youtubeTranscripts)
      .values({
        workspaceId: auth.workspaceId,
        documentId: input.documentId,
        videoId: input.videoId,
        language: input.language,
        cues: input.cues,
        generated: input.generated,
        extractionId: latest?.id ?? null,
      })
      .onConflictDoUpdate({
        target: [youtubeTranscripts.documentId],
        set: {
          videoId: input.videoId,
          language: input.language,
          cues: input.cues,
          generated: input.generated,
          extractionId: latest?.id ?? null,
        },
      });
  });
}

/** Records why a video has no transcript, in the same place a failed fetch goes. */
async function recordTranscriptFailure(auth: AuthContext, documentId: string, error: string) {
  const contentHash = `unfetched-youtube:${documentId}`;
  await db
    .insert(documentExtractions)
    .values({ workspaceId: auth.workspaceId, documentId, contentHash, status: "failed", error, extractor: "youtube-transcript" })
    .onConflictDoUpdate({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
      set: { error, createdAt: new Date() },
    });
  // The source row exists so the owner can see the attempt and retry it.
  await db
    .insert(sources)
    .values({
      workspaceId: auth.workspaceId,
      kind: "document",
      title: `YouTube ${documentId}`,
      url: `https://www.youtube.com/watch?v=${documentId}`,
      contentHash,
      fetchedAt: new Date(),
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    .onConflictDoNothing({ target: [sources.workspaceId, sources.url, sources.contentHash] });
}

/*
 * URL import (NotebookLM parity, S2). A search result selected in the discovery
 * panel is fetched later, not in the request. This reuses captureUrl, which
 * already dedupes by canonical URL and records fetch failures on an extraction
 * row.
 *
 * captureUrl is synchronous by design and bounded by its own fetch timeouts;
 * running it from the outbox keeps the request short without a second fetch
 * path.
 */
export const URL_IMPORT_TOPIC = "source.url_import_requested";

export const urlImportHandler: OutboxHandler = async (event: ClaimedOutboxEvent) => {
  const raw = event.payload ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`source.url_import_requested has a malformed payload (${typeof raw}); redeploy the producer`);
  }
  const url = typeof (raw as { url?: unknown }).url === "string" ? (raw as { url: string }).url : null;
  if (!url) throw new Error("source.url_import_requested has no url");

  const auth = await workspaceOwnerAuth(event.workspaceId);
  if (!auth) throw new Error("workspace has no active owner to receive the source");

  const result = await captureUrl(auth, { url });
  // A fetch failure is recorded on the document and shown in readiness; it is
  // not a reason to retry the same dead address five times.
  if (!result.ok && !result.documentId) throw new Error(result.error);
};

export const youtubeHandlers: Record<string, OutboxHandler> = {
  [YOUTUBE_TOPIC]: youtubeTranscriptRequestedHandler,
  [URL_IMPORT_TOPIC]: urlImportHandler,
};
