import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { linkCaptureDocument, captureInWorkspace } from "@/domains/capture/children";
import type { AuthContext } from "@/domains/identity/resolve";
import type { GenerationJobRun, GenerationJobRunner } from "@/domains/jobs/runners";
import { GenerationJobFailure } from "@/domains/jobs/state";
import {
  groqWhisperConfigured,
  transcribeClipWithGroq,
  type AudioClip,
  type SpeechSegment,
} from "@/integrations/transcription/groq-whisper";
import { canonicalVideoUrl, fetchTranscript, type TranscriptCue } from "@/integrations/youtube/transcript";
import { db } from "@/lib/db";
import { withTransaction } from "@/lib/db-transaction";
import { sha256Hex } from "@/lib/hash";
import { extractDocument } from "./extraction";
import { DocumentAlreadyHasFileError, intakeFile } from "./intake";
import { documentExtractions, documents, sources, videoTranscripts, youtubeTranscripts } from "./schema";
import { recordSource } from "./sources";

/*
 * Absorbing a YouTube video: one generation job ("knowledge.youtube") per
 * video document, which the person watches in the jobs panel.
 *
 *   1. the transcript: the shared cache (video_transcripts) first, then the
 *      video's own captions (free, one or two seconds), and only when the
 *      video has none, its speech transcribed by Groq Whisper in clips of
 *      SPEECH_CLIP_SECONDS (about $0.04 an hour), with the spend recorded on
 *      the job. Whatever was made is cached by video id, so absorbing the
 *      same video again, anywhere, costs nothing;
 *   2. the text filed as the document's bytes, with its source identity;
 *   3. the cue table, so a citation can deep-link to ?t=<seconds>;
 *   4. the normal extraction pass over the text.
 *
 * Each step is idempotent: a retried job finds the file already attached and
 * the transcript cached. A video that cannot be transcribed fails the job
 * with a reason and records the failure on the document, where the notebook's
 * source list shows it and offers a retry.
 */

export const YOUTUBE_ABSORB_KIND = "knowledge.youtube";

/** Speech is transcribed in clips this long: well inside Groq's 25 MB upload limit at audio bitrates. */
export const SPEECH_CLIP_SECONDS = 20 * 60;

const inputSchema = z.object({
  documentId: z.uuid(),
  videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  /** The capture the video belongs to, when it was captured from the inbox. */
  captureId: z.uuid().optional(),
});

export type YouTubeAbsorbInput = z.infer<typeof inputSchema>;

/**
 * Where a video's audio comes from when it has no captions. Asked for the
 * video's length first, then for each clip of SPEECH_CLIP_SECONDS.
 */
export type VideoAudioSource = {
  durationSeconds(videoId: string, signal: AbortSignal): Promise<number>;
  clip(videoId: string, range: { from: number; to: number }, signal: AbortSignal): Promise<AudioClip>;
};

export type YouTubeAbsorbDeps = {
  fetchCaptions?: typeof fetchTranscript;
  transcribeClip?: typeof transcribeClipWithGroq;
  /** Null: no audio can be had, so a video without captions fails with that reason. */
  audio?: VideoAudioSource | null;
};

type Transcript = {
  title: string | null;
  cues: TranscriptCue[];
  language: string | null;
  generated: boolean;
  source: "captions" | "speech";
  /** True when it came from the cache: nothing was fetched or paid for this time. */
  cached: boolean;
};

/** The clips a speech transcription is split into, as [from, to) seconds. */
export function speechClips(durationSeconds: number): Array<{ from: number; to: number }> {
  const clips: Array<{ from: number; to: number }> = [];
  for (let from = 0; from < durationSeconds; from += SPEECH_CLIP_SECONDS) {
    clips.push({ from, to: Math.min(durationSeconds, from + SPEECH_CLIP_SECONDS) });
  }
  return clips;
}

/** Whisper segments of one clip as cues on the video's own clock. */
export function clipCues(segments: SpeechSegment[], offsetSeconds: number): TranscriptCue[] {
  return segments.map((segment) => ({
    start: round3(segment.start + offsetSeconds),
    duration: round3(Math.max(0, segment.end - segment.start)),
    text: segment.text,
  }));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

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
    let notice: string | null = null;
    if (!doc.fileId) {
      let transcript: Transcript;
      try {
        transcript = await videoTranscript(input.videoId, run, deps);
      } catch (cause) {
        if (cause instanceof GenerationJobFailure) await recordTranscriptFailure(auth, doc.id, cause.message);
        throw cause;
      }
      await run.progress("Filing the transcript");
      await fileTranscript(auth, { documentId: doc.id, videoId: input.videoId, fallbackTitle: doc.title, transcript });
      await run.progress("Reading the transcript");
      // The text is durable now; a failed extraction is retried from the source list like any document's.
      await extractDocument(auth, { documentId: doc.id });
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
  if (transcript.cached) return `Used the saved transcript (${length}).`;
  return transcript.source === "captions"
    ? `Read from the video's captions (${length}).`
    : `Transcribed from the video's speech (${length}).`;
}

/** The cache, then the captions, then the speech. Throws GenerationJobFailure with a reason a person can read. */
async function videoTranscript(videoId: string, run: GenerationJobRun, deps: YouTubeAbsorbDeps): Promise<Transcript> {
  const [cached] = await db.select().from(videoTranscripts).where(eq(videoTranscripts.videoId, videoId)).limit(1);
  if (cached) {
    return {
      title: cached.title,
      cues: cached.cues as TranscriptCue[],
      language: cached.language,
      generated: cached.generated,
      source: cached.source === "speech" ? "speech" : "captions",
      cached: true,
    };
  }

  await run.progress("Looking for captions");
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
      source: "captions",
      cached: false,
    };
    await cacheTranscript(videoId, transcript, 0);
    return transcript;
  }
  if (!captions.error.includes("no captions")) throw new GenerationJobFailure(captions.error);

  const audio = deps.audio === undefined ? null : deps.audio;
  if (!audio || !groqWhisperConfigured()) {
    throw new GenerationJobFailure("This video has no captions, and transcribing speech is not set up here.");
  }
  return transcribeSpeech(videoId, audio, run, deps.transcribeClip ?? transcribeClipWithGroq);
}

async function transcribeSpeech(
  videoId: string,
  audio: VideoAudioSource,
  run: GenerationJobRun,
  transcribe: typeof transcribeClipWithGroq,
): Promise<Transcript> {
  await run.progress("Fetching the audio");
  const duration = await audio.durationSeconds(videoId, run.signal);
  const clips = speechClips(duration);
  if (clips.length === 0) throw new GenerationJobFailure("This video has no audio to transcribe.");
  const cues: TranscriptCue[] = [];
  let spent = 0;
  for (const [index, range] of clips.entries()) {
    await run.progress("Transcribing speech", { done: index, total: clips.length });
    let clip: AudioClip;
    let heard: Awaited<ReturnType<typeof transcribeClipWithGroq>>;
    try {
      clip = await audio.clip(videoId, range, run.signal);
      heard = await transcribe(clip, { signal: run.signal });
    } catch (cause) {
      if (run.signal.aborted) throw cause;
      throw new GenerationJobFailure("The video's speech could not be transcribed. Try again.");
    }
    await run.spend(heard.costMicroUsd);
    spent += heard.costMicroUsd;
    cues.push(...clipCues(heard.segments, range.from));
  }
  if (cues.length === 0) throw new GenerationJobFailure("No speech was heard in this video.");
  const transcript: Transcript = { title: null, cues, language: null, generated: true, source: "speech", cached: false };
  await cacheTranscript(videoId, transcript, spent);
  return transcript;
}

async function cacheTranscript(videoId: string, transcript: Transcript, costMicroUsd: number): Promise<void> {
  await db
    .insert(videoTranscripts)
    .values({
      videoId,
      source: transcript.source,
      title: transcript.title,
      language: transcript.language,
      generated: transcript.generated,
      cues: transcript.cues,
      costMicroUsd,
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
