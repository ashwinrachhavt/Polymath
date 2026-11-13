import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { linkCaptureDocument, captureInWorkspace } from "@/domains/capture/children";
import type { AuthContext } from "@/domains/identity/resolve";
import type { GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure } from "@/domains/jobs/state";
import { canonicalVideoUrl, fetchTranscript, type TranscriptCue } from "@/integrations/youtube/transcript";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { DocumentAlreadyHasFileError, intakeFile } from "./intake";
import { documentExtractions, documents, sources, videoTranscripts, youtubeTranscripts } from "./schema";
import { recordSource } from "./sources";

/*
 * Absorbing a YouTube video: one generation job ("knowledge.youtube") per
 * video document, which the person watches in the jobs panel.
 *
 *   1. the transcript: the shared cache (video_transcripts) first, then the
 *      video's own captions (free, well under a second). Whatever was found is
 *      cached by video id, so absorbing the same video again, anywhere, is
 *      instant;
 *   2. the text filed as the document's bytes, with its source identity;
 *   3. the cue table, so a citation can deep-link to ?t=<seconds>.
 *
 * A video with no captions is skipped: the job ends ready with that said
 * plainly, and the document records why, so the notebook's source list shows
 * it. Transcribing speech was weighed and left out on purpose (cost and
 * moving parts for the minority of videos without captions).
 *
 * The job is ready once the transcript is filed. Extraction (chunking,
 * embeddings, zettel proposals) is the document pipeline's own work, queued by
 * intakeFile as `document.extraction_requested` exactly as for an upload or a
 * crawled page; it takes far longer than the transcript (tens of seconds for
 * an hour of speech) and has its own state on the source row, so the job does
 * not wait for it. Each step is idempotent: a retried job finds the file
 * already attached and the transcript cached.
 */

export const YOUTUBE_ABSORB_KIND = "knowledge.youtube";

/** What a skipped video says, on the job and on its document. */
const NO_CAPTIONS_COPY = "No captions, so this video was skipped.";

const inputSchema = z.object({
  documentId: z.uuid(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  /** The capture the video belongs to, when it was captured from the inbox. */
  captureId: z.uuid().optional(),
});

export type YouTubeAbsorbInput = z.infer<typeof inputSchema>;

export type YouTubeAbsorbDeps = {
  fetchCaptions?: typeof fetchTranscript;
};

type Transcript = {
  title: string | null;
  cues: TranscriptCue[];
  language: string | null;
  generated: boolean;
  /** True when it came from the cache: nothing was fetched this time. */
  cached: boolean;
};

export const youtubeAbsorbRunner =
  (deps: YouTubeAbsorbDeps = {}): GenerationJobRunner =>
  async (auth, raw, run) => {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("malformed youtube job input");
    const input = parsed.data;
    const [doc] = await db
      .select({ id: documents.id, fileId: documents.fileId, title: documents.title })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.workspaceId, auth.workspaceId)))
      .limit(1);
    if (!doc) throw new GenerationJobFailure("The video was removed from your library before it was read.");
    const result = (notice: string) => ({ href: `/polymath/knowledge?doc=${doc.id}`, notice });

    let notice: string | null = null;
    if (!doc.fileId) {
      const transcript = await videoTranscript(input.videoId, run.progress, deps);
      if (!transcript) {
        await recordTranscriptFailure(auth, doc.id, NO_CAPTIONS_COPY);
        return result(NO_CAPTIONS_COPY);
      }
      await run.progress("Filing the transcript");
      await fileTranscript(auth, { documentId: doc.id, videoId: input.videoId, fallbackTitle: doc.title, transcript });
      notice = transcriptNotice(transcript);
    }
    if (input.captureId && (await captureInWorkspace(auth, input.captureId))) {
      await linkCaptureDocument(auth, { captureId: input.captureId, documentId: doc.id, position: 0 });
    }
    return { href: `/polymath/knowledge?doc=${doc.id}`, notice };
  };

function transcriptNotice(transcript: Transcript): string {
  const minutes = Math.round((transcript.cues.at(-1)?.start ?? 0) / 60);
  const length = minutes > 0 ? `${minutes} min` : "short";
  return transcript.cached ? `Used the saved transcript (${length}).` : `Read from the video's captions (${length}).`;
}

/**
 * The cache, then the captions. Null when the video has none. Throws
 * GenerationJobFailure (with a retry) when YouTube could not answer.
 */
async function videoTranscript(
  videoId: string,
  progress: (step: string) => Promise<void>,
  deps: YouTubeAbsorbDeps,
): Promise<Transcript | null> {
  const [cached] = await db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId)).limit(1);
  if (cached) {
    return {
      title: cached.title,
      cues: cached.cues as TranscriptCue[],
      language: cached.language,
      generated: cached.generated,
      cached: true,
    };
  }

  await progress("Fetching captions");
  let captions;
  try {
    captions = await (deps.fetchCaptions ?? fetchTranscript)(canonicalVideoUrl(videoId));
  } catch {
    throw new GenerationJobFailure("YouTube could not be reached. Try again.");
  }
  if (captions.ok) {
    const transcript: Transcript = {
      title: captions.title,
      cues: captions.cues,
      language: captions.language,
      generated: captions.generated,
      cached: false,
    };
    await cacheTranscript(videoId, transcript);
    return transcript;
  }
  if (captions.error.includes("no captions")) return null;
  throw new GenerationJobFailure(captions.error);
}

async function cacheTranscript(videoId: string, transcript: Transcript): Promise<void> {
  await db
    .insert(videoTranscripts)
    .values({
      videoId,
      title: transcript.title,
      language: transcript.language,
      generated: transcript.generated,
      cues: transcript.cues,
    })
    .onConflictDoNothing();
}

/** The transcript as the document's text, its source row, and its cue table. */
async function fileTranscript(
  auth: AuthContext,
  input: { documentId: string; videoId: string; fallbackTitle: string; transcript: Transcript },
): Promise<void> {
  const { transcript } = input;
  const canonicalUrl = canonicalVideoUrl(input.videoId);
  const title = transcript.title ?? input.fallbackTitle;
  const bytes = new TextEncoder().encode(transcript.cues.map((cue) => cue.text).join("\n"));
  const contentHash = await sha256Hex(bytes);
  try {
    await intakeFile(auth, {
      bytes,
      filename: `${input.videoId}.txt`,
      title,
      verdict: { ok: true, mimeType: "text/plain" },
      contentHash,
      origin: "youtube",
      sourceUrl: canonicalUrl,
      documentId: input.documentId,
      // A video source is a document source: dossiers.sourceFor matches kind
      // "document", and a "video" kind would mint a second sources row for the
      // same file.
      inTransaction: (tx) => recordSource(auth, tx, { title, url: canonicalUrl, contentHash, kind: "document" }),
    });
  } catch (cause) {
    // A concurrent run filed the same bytes; that is the success case.
    if (!(cause instanceof DocumentAlreadyHasFileError)) throw cause;
  }
  await writeCues(auth, { ...input, transcript });
}

/** The cue table is replaced, not appended: one document has one transcript. */
async function writeCues(auth: AuthContext, input: { documentId: string; videoId: string; transcript: Transcript }) {
  const [latest] = await db
    .select({ id: documentExtractions.id })
    .from(documentExtractions)
    .where(
      and(eq(documentExtractions.documentId, input.documentId), eq(documentExtractions.workspaceId, auth.workspaceId)),
    )
    .orderBy(desc(documentExtractions.createdAt))
    .limit(1);
  const values = {
    videoId: input.videoId,
    language: input.transcript.language,
    cues: input.transcript.cues,
    generated: input.transcript.generated,
    extractionId: latest?.id ?? null,
  };
  await withTransaction(async (tx) => {
    await tx
      .insert(youtubeTranscripts)
      .values({ workspaceId: auth.workspaceId, documentId: input.documentId, ...values })
      .onConflictDoUpdate({ target: [youtubeTranscripts.documentId], set: values });
  });
}

/** Records why a video has no transcript, in the same place a failed fetch goes. */
async function recordTranscriptFailure(auth: AuthContext, documentId: string, error: string) {
  const contentHash = `unfetched-youtube:${documentId}`;
  const [doc] = await db
    .select({ sourceUrl: documents.sourceUrl, title: documents.title })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.workspaceId, auth.workspaceId)))
    .limit(1);
  await db
    .insert(documentExtractions)
    .values({
      workspaceId: auth.workspaceId,
      documentId,
      contentHash,
      status: "failed",
      error,
      extractor: "youtube-transcript",
    })
    .onConflictDoUpdate({
      target: [documentExtractions.documentId, documentExtractions.contentHash],
      set: { error, createdAt: new Date() },
    });
  // The source row exists so the owner can see the attempt and retry it. The
  // url is the document's canonical address, the same key the notebook attach
  // bound by, so the failed state lands on the row the pane already shows.
  await db
    .insert(sources)
    .values({
      workspaceId: auth.workspaceId,
      kind: "document",
      title: doc?.title ?? `YouTube ${documentId}`,
      url: doc?.sourceUrl ?? `https://www.youtube.com/watch?v=${documentId}`,
      contentHash,
      fetchedAt: new Date(),
      createdBy: auth.userId,
      updatedBy: auth.userId,
    })
    // The index is partial; naming its predicate is what lets Postgres match it.
    .onConflictDoNothing({
      target: [sources.workspaceId, sources.url, sources.contentHash],
      where: sql`url is not null and content_hash is not null`,
    });
}
